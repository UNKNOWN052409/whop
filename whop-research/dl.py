import urllib.request, ssl, os
ctx = ssl.create_default_context()
targets = {
  "stable.json": "https://docs.whop.com/openapi/api-v1-stable.json",
  "native.json": "https://docs.whop.com/openapi/api-v1-native.json",
}
for name, url in targets.items():
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        data = urllib.request.urlopen(req, timeout=120, context=ctx).read()
        open(os.path.join("whop-research", name), "wb").write(data)
        print(name, "OK", len(data))
    except Exception as e:
        print(name, "FAIL", repr(e)[:300])
