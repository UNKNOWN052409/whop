/**
 * Database seed.
 *
 * IMPORTANT — READ BEFORE RUNNING IN PRODUCTION.
 *
 * This seed creates the CATALOG (products, suppliers, pricing rules) and the
 * bootstrap admin account. It deliberately creates NO redeem codes.
 *
 * Spec section 24 forbids hard-coded inventory, and spec section 3 requires
 * inventory to come from an authorized supplier feed. Seeding fake codes would
 * mean selling customers codes that do not exist, so inventory is imported
 * through the admin CSV importer (or a supplier integration) instead.
 *
 * The supplier costs below are PLACEHOLDERS. They exist so the margin engine
 * has something to evaluate on a fresh install. Replace every one of them with
 * your real contracted supplier pricing before accepting live orders — a
 * placeholder cost that understates your true cost will publish products at a
 * margin you do not actually have.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { discountBps, marginBps } from '../src/lib/money';
import { hashCodeForSeed } from './seed-crypto';

const prisma = new PrismaClient();

const CURRENCY = 'usd';

interface SeedProduct {
  slug: string;
  productName: string;
  brand: string;
  category: string;
  region: string;
  description: string;
  /** What the customer RECEIVES (face value), in minor units. */
  faceValueMinor: number;
  /** What the customer PAYS, in minor units. */
  sellingPriceMinor: number;
  /** PLACEHOLDER supplier cost in minor units — replace before going live. */
  supplierCostMinor: number;
  supplierSku: string;
  imageUrl: string;
}

/**
 * The documented price tiers from the specification:
 *   $3 -> $1, $6 -> $2, $15 -> $5, $30 -> $10
 * These are catalog seed DATA, not payment logic. Changing a price here or in
 * the admin panel changes what customers pay; the payment engine reads the
 * price off the order snapshot at checkout and is unaffected.
 */
const PRODUCTS: SeedProduct[] = [
  {
    slug: 'redeem-code-1-usd',
    productName: '$1 Digital Redeem Code',
    brand: 'Store',
    category: 'Digital Redeem Code',
    region: 'US',
    description:
      'A $1 digital redeem code delivered instantly to your email. No card details required at redemption on supported platforms.',
    faceValueMinor: 100,
    sellingPriceMinor: 300,
    supplierCostMinor: 70,
    supplierSku: 'REDEEM-1-USD',
    imageUrl: '/products/redeem-1.png',
  },
  {
    slug: 'redeem-code-2-usd',
    productName: '$2 Digital Redeem Code',
    brand: 'Store',
    category: 'Digital Redeem Code',
    region: 'US',
    description:
      'A $2 digital redeem code delivered instantly to your email. No card details required at redemption on supported platforms.',
    faceValueMinor: 200,
    sellingPriceMinor: 600,
    supplierCostMinor: 140,
    supplierSku: 'REDEEM-2-USD',
    imageUrl: '/products/redeem-2.png',
  },
  {
    slug: 'redeem-code-5-usd',
    productName: '$5 Digital Redeem Code',
    brand: 'Store',
    category: 'Digital Redeem Code',
    region: 'US',
    description:
      'A $5 digital redeem code delivered instantly to your email. No card details required at redemption on supported platforms.',
    faceValueMinor: 500,
    sellingPriceMinor: 1500,
    supplierCostMinor: 350,
    supplierSku: 'REDEEM-5-USD',
    imageUrl: '/products/redeem-5.png',
  },
  {
    slug: 'redeem-code-10-usd',
    productName: '$10 Digital Redeem Code',
    brand: 'Store',
    category: 'Digital Redeem Code',
    region: 'US',
    description:
      'A $10 digital redeem code delivered instantly to your email. No card details required at redemption on supported platforms.',
    faceValueMinor: 1000,
    sellingPriceMinor: 3000,
    supplierCostMinor: 700,
    supplierSku: 'REDEEM-10-USD',
    imageUrl: '/products/redeem-10.png',
  },
  {
    slug: 'amazon-gift-card-5-usd',
    productName: 'Amazon.com Gift Card $5',
    brand: 'Amazon',
    category: 'Gift Card',
    region: 'US',
    description:
      'An Amazon.com digital gift card with $5 of gift card balance, delivered by email. Works across Amazon.com; excludes gift card purchases, book orders, and subscriptions where Amazon restricts gift cards. US residents only.',
    faceValueMinor: 500,
    sellingPriceMinor: 1400,
    supplierCostMinor: 460,
    supplierSku: 'AMZN-GC-5-US',
    imageUrl: '/products/amazon-5.png',
  },
  {
    slug: 'amazon-gift-card-10-usd',
    productName: 'Amazon.com Gift Card $10',
    brand: 'Amazon',
    category: 'Gift Card',
    region: 'US',
    description:
      'An Amazon.com digital gift card with $10 of gift card balance, delivered by email. Works across Amazon.com; excludes gift card purchases, book orders, and subscriptions where Amazon restricts gift cards. US residents only.',
    faceValueMinor: 1000,
    sellingPriceMinor: 2600,
    supplierCostMinor: 920,
    supplierSku: 'AMZN-GC-10-US',
    imageUrl: '/products/amazon-10.png',
  },
];

/**
 * Compliance guardrail (spec sections 3 and 4).
 *
 * These products may only be activated if their codes were obtained through an
 * authorized reseller or supplier contract. Inventory import is the only path
 * by which codes enter the system, so a product with zero inventory cannot
 * sell and cannot accidentally ship codes from an unauthorized source.
 *
 * If you obtained gift cards by scraping, from leaked voucher dumps, or by
 * abusing consumer accounts, do not activate these products. Reselling stolen
 * or fraudulently obtained gift cards is fraud, carries the chargeback risk
 * modelled in the risk engine, and is a criminal offence in most jurisdictions.
 */
const SUPPLIERS = [
  {
    name: 'Primary Authorized Distributor',
    authorizationRef: process.env.SUPPLIER_AUTHORIZATION_REF ?? null,
    notes:
      'Placeholder supplier. Set SUPPLIER_AUTHORIZATION_REF and replace supplierCostMinor on each ' +
      'product with your real contracted pricing before enabling the storefront.',
  },
];

async function main() {
  console.log('Seeding catalog, pricing rules and bootstrap admin…\n');

  // --- Pricing rules (spec section 3) --------------------------------------
  // minDiscountBps is evaluated against the ABSOLUTE value of the discount.
  // This catalog sells at a premium, so every product has a negative discount
  // (a markup); the rule therefore acts as a sanity floor that a product is not
  // being sold below cost relative to its own face value.
  const globalRule = await prisma.pricingRule.upsert({
    where: { name: 'default-global' },
    update: {},
    create: {
      name: 'default-global',
      minDiscountBps: Number(process.env.DEFAULT_MIN_DISCOUNT_BPS ?? 500),
      minMarginBps: Number(process.env.DEFAULT_MIN_MARGIN_BPS ?? 0),
      category: null,
      active: true,
      autoHideOnFail: true,
    },
  });
  console.log(`  pricing rule: ${globalRule.name} (min discount ${globalRule.minDiscountBps}bps)`);

  // --- Suppliers ------------------------------------------------------------
  const supplierRecords = [];
  for (const supplier of SUPPLIERS) {
    const record = await prisma.supplier.upsert({
      where: { name: supplier.name },
      update: { authorizationRef: supplier.authorizationRef },
      create: {
        name: supplier.name,
        authorizationRef: supplier.authorizationRef,
        notes: supplier.notes,
        active: true,
      },
    });
    supplierRecords.push(record);
    console.log(`  supplier: ${record.name}`);
  }
  const supplier = supplierRecords[0]!;

  // --- Products -------------------------------------------------------------
  for (const item of PRODUCTS) {
    const discount = discountBps(item.faceValueMinor, item.sellingPriceMinor);
    const margin = marginBps(item.sellingPriceMinor, item.supplierCostMinor);

    // A product only activates if its margin clears the configured rule.
    const meetsMargin = margin >= globalRule.minMarginBps;
    const status = meetsMargin ? 'ACTIVE' : 'HIDDEN';

    const product = await prisma.product.upsert({
      where: { slug: item.slug },
      update: {
        productName: item.productName,
        brand: item.brand,
        category: item.category,
        region: item.region,
        description: item.description,
        imageUrl: item.imageUrl,
        currency: CURRENCY,
        faceValueMinor: item.faceValueMinor,
        sellingPriceMinor: item.sellingPriceMinor,
        supplierCostMinor: item.supplierCostMinor,
        discountBps: discount,
        marginBps: margin,
        deliveryMethod: 'EMAIL',
      },
      create: {
        slug: item.slug,
        productName: item.productName,
        brand: item.brand,
        category: item.category,
        region: item.region,
        description: item.description,
        imageUrl: item.imageUrl,
        currency: CURRENCY,
        faceValueMinor: item.faceValueMinor,
        sellingPriceMinor: item.sellingPriceMinor,
        supplierCostMinor: item.supplierCostMinor,
        discountBps: discount,
        marginBps: margin,
        deliveryMethod: 'EMAIL',
        status,
        inventoryCount: 0,
      },
    });

    await prisma.productProvider.upsert({
      where: { productId_supplierId: { productId: product.id, supplierId: supplier.id } },
      update: {
        supplierSku: item.supplierSku,
        supplierCostMinor: item.supplierCostMinor,
        currency: CURRENCY,
        region: item.region,
        active: true,
      },
      create: {
        productId: product.id,
        supplierId: supplier.id,
        supplierSku: item.supplierSku,
        supplierCostMinor: item.supplierCostMinor,
        currency: CURRENCY,
        region: item.region,
        active: true,
      },
    });

    console.log(
      `  product: ${product.productName.padEnd(28)} pays $${(item.sellingPriceMinor / 100).toFixed(2)}` +
        ` -> value $${(item.faceValueMinor / 100).toFixed(2)}` +
        `  margin ${(margin / 100).toFixed(1)}%  [${status}]`,
    );
  }

  // --- Bootstrap admin (spec section 15) ------------------------------------
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (email && password) {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.upsert({
      where: { email: email.toLowerCase() },
      update: { role: 'OWNER' },
      create: {
        email: email.toLowerCase(),
        name: 'Owner',
        passwordHash,
        role: 'OWNER',
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`\n  admin: ${email} (role OWNER)`);
    console.log('  Sign in at /admin, then enrol MFA — spec section 23 requires it for OWNER.');
    console.log('  Enrolment is POST /api/auth/mfa/enrol (see DEPLOY.md section 8.4);');
    console.log('  there is no /admin/account page yet, so the request must be made from the');
  } else {
    console.log('\n  admin: SKIPPED — set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD to create one.');
  }

  console.log('\nSeed complete.');
  console.log(
    'Reminder: NO redeem codes were created. Import authorized inventory via\n' +
      '  /admin/inventory  (CSV upload)\n' +
      'Products with zero inventory cannot be sold. Replace the placeholder\n' +
      'supplier costs before enabling live checkout.',
  );

  // Sanity check on the fingerprint helper so a misconfigured key fails here
  // rather than during the first inventory import.
  const probe = hashCodeForSeed('SEED-PROBE-NOT-A-REAL-CODE');
  if (!probe) throw new Error('seed-crypto probe failed');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });