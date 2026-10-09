prisma.cmd : warn The configuration property `package.json#prisma` is deprecated and will be removed in Prisma 7. 
Please migrate to a Prisma config file (e.g., `prisma.config.ts`).
At line:5 char:8
+ $sql = & "$w\node_modules\.bin\prisma.cmd" migrate diff --from-empty  ...
+        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (warn The config...ma.config.ts`).:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
For more information, see: https://pris.ly/prisma-config

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'SUPPORT', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'HIDDEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'ASSIGNED', 'DELIVERED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAYMENT_PENDING', 'PAYMENT_VERIFIED', 'FULFILLMENT_PENDING', 'CODE_RESERVED', 'CODE_DELIVERED', 'COMPLETED', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED', 'PAYMENT_REVERSED', 'FULFILLMENT_FAILED', 'REFUND_PENDING', 'REFUNDED', 'MANUAL_REVIEW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'REQUIRES_ACTION', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('WHOP', 'WHOP_SANDBOX', 'STRIPE');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "EmailProviderKind" AS ENUM ('SES', 'RESEND', 'SMTP');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskDecision" AS ENUM ('ALLOW', 'REVIEW', 'BLOCK');

-- CreateEnum
CREATE TYPE "ReconciliationType" AS ENUM ('MISSING_PAYMENT', 'DUPLICATE_PAYMENT', 'WRONG_AMOUNT', 'WRONG_CURRENCY', 'REVERSED_PAYMENT', 'FAILED_WEBHOOK', 'MISSING_WEBHOOK', 'STUCK_ORDER', 'FULFILLMENT_MISMATCH', 'INVENTORY_DEPLETED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'IGNORED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "emailVerifiedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "mfaSecretCiphertext" TEXT,
    "mfaEnabledAt" TIMESTAMP(3),
    "mfaRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credentialsCiphertext" TEXT,
    "authorizationRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minDiscountBps" INTEGER NOT NULL DEFAULT 500,
    "minMarginBps" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "autoHideOnFail" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'US',
    "description" TEXT,
    "imageUrl" TEXT,
    "currency" TEXT NOT NULL,
    "faceValueMinor" INTEGER NOT NULL,
    "sellingPriceMinor" INTEGER NOT NULL,
    "supplierCostMinor" INTEGER NOT NULL,
    "discountBps" INTEGER NOT NULL DEFAULT 0,
    "marginBps" INTEGER NOT NULL DEFAULT 0,
    "deliveryMethod" "DeliveryMethod" NOT NULL DEFAULT 'EMAIL',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "inventoryCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductProvider" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "supplierCostMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'US',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCode" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT,
    "externalRef" TEXT,
    "codeCiphertext" TEXT NOT NULL,
    "codeLast4" TEXT NOT NULL,
    "codeFingerprint" TEXT NOT NULL,
    "redemptionInstructions" TEXT,
    "region" TEXT NOT NULL DEFAULT 'US',
    "currency" TEXT NOT NULL,
    "faceValueMinor" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" "InventoryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "reservedAt" TIMESTAMP(3),
    "reservationExpiresAt" TIMESTAMP(3),
    "orderId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryImportBatch" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT,
    "productId" TEXT,
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT,
    "productName" TEXT NOT NULL,
    "faceValueMinor" INTEGER NOT NULL,
    "sellingPriceMinor" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerEmailNormalized" TEXT NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "deliveryMethod" "DeliveryMethod" NOT NULL DEFAULT 'EMAIL',
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "riskScore" INTEGER,
    "riskDecision" "RiskDecision" NOT NULL DEFAULT 'ALLOW',
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "manualReviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStateTransition" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromState" "OrderStatus",
    "toState" "OrderStatus" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "providerPaymentId" TEXT,
    "providerCheckoutId" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "verifiedAt" TIMESTAMP(3),
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "netAmountMinor" INTEGER,
    "feeMinor" INTEGER,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "declineCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "accountId" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "signatureValid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentJob" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "FulfillmentStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "inventoryAllocatedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentJobId" TEXT,
    "paymentId" TEXT,
    "email" TEXT NOT NULL,
    "provider" "EmailProviderKind" NOT NULL,
    "providerMessageId" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "failureMessage" TEXT,
    "initiatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FraudEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "userId" TEXT,
    "emailNormalized" TEXT,
    "ipHash" TEXT,
    "type" TEXT NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "decision" "RiskDecision" NOT NULL DEFAULT 'ALLOW',
    "score" INTEGER,
    "signals" JSONB NOT NULL,
    "metadata" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FraudEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRecord" (
    "id" TEXT NOT NULL,
    "type" "ReconciliationType" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "orderId" TEXT,
    "paymentId" TEXT,
    "providerPaymentId" TEXT,
    "expected" JSONB,
    "actual" JSONB,
    "discrepancy" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ReconciliationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "orderId" TEXT,
    "requestHash" TEXT NOT NULL,
    "responseJson" JSONB,
    "statusCode" INTEGER,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerLease" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRule_name_key" ON "PricingRule"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_status_category_idx" ON "Product"("status", "category");

-- CreateIndex
CREATE INDEX "Product_brand_idx" ON "Product"("brand");

-- CreateIndex
CREATE INDEX "ProductProvider_supplierId_idx" ON "ProductProvider"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductProvider_productId_supplierId_key" ON "ProductProvider"("productId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCode_orderId_key" ON "InventoryCode"("orderId");

-- CreateIndex
CREATE INDEX "InventoryCode_status_productId_idx" ON "InventoryCode"("status", "productId");

-- CreateIndex
CREATE INDEX "InventoryCode_status_reservationExpiresAt_idx" ON "InventoryCode"("status", "reservationExpiresAt");

-- CreateIndex
CREATE INDEX "InventoryCode_status_expiresAt_idx" ON "InventoryCode"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "InventoryCode_importBatchId_idx" ON "InventoryCode"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCode_productId_codeFingerprint_key" ON "InventoryCode"("productId", "codeFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Order_reference_key" ON "Order"("reference");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_customerEmailNormalized_idx" ON "Order"("customerEmailNormalized");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "OrderStateTransition_orderId_createdAt_idx" ON "OrderStateTransition"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "Payment_provider_providerPaymentId_idx" ON "Payment"("provider", "providerPaymentId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_providerEventId_key" ON "PaymentEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "PaymentEvent_eventType_idx" ON "PaymentEvent"("eventType");

-- CreateIndex
CREATE INDEX "PaymentEvent_orderId_idx" ON "PaymentEvent"("orderId");

-- CreateIndex
CREATE INDEX "PaymentEvent_signatureValid_receivedAt_idx" ON "PaymentEvent"("signatureValid", "receivedAt");

-- CreateIndex
CREATE INDEX "FulfillmentJob_status_nextAttemptAt_idx" ON "FulfillmentJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentJob_orderId_key" ON "FulfillmentJob"("orderId");

-- CreateIndex
CREATE INDEX "Delivery_status_idx" ON "Delivery"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_orderId_key" ON "Delivery"("orderId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_orderId_key" ON "Refund"("orderId");

-- CreateIndex
CREATE INDEX "FraudEvent_orderId_idx" ON "FraudEvent"("orderId");

-- CreateIndex
CREATE INDEX "FraudEvent_riskLevel_createdAt_idx" ON "FraudEvent"("riskLevel", "createdAt");

-- CreateIndex
CREATE INDEX "FraudEvent_emailNormalized_createdAt_idx" ON "FraudEvent"("emailNormalized", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_status_type_idx" ON "ReconciliationRecord"("status", "type");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_createdAt_idx" ON "ReconciliationRecord"("createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_orderId_idx" ON "ReconciliationRecord"("orderId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_scope_key_key" ON "IdempotencyKey"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerLease_name_key" ON "WorkerLease"("name");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductProvider" ADD CONSTRAINT "ProductProvider_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductProvider" ADD CONSTRAINT "ProductProvider_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCode" ADD CONSTRAINT "InventoryCode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCode" ADD CONSTRAINT "InventoryCode_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCode" ADD CONSTRAINT "InventoryCode_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStateTransition" ADD CONSTRAINT "OrderStateTransition_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentJob" ADD CONSTRAINT "FulfillmentJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_fulfillmentJobId_fkey" FOREIGN KEY ("fulfillmentJobId") REFERENCES "FulfillmentJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudEvent" ADD CONSTRAINT "FraudEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudEvent" ADD CONSTRAINT "FraudEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRecord" ADD CONSTRAINT "ReconciliationRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRecord" ADD CONSTRAINT "ReconciliationRecord_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

