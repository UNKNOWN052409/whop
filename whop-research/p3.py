import urllib.request
cands = [
 "https://docs.whop.com/openapi/api-v1-native.json",
 "https://docs.whop.com/api/openapi.json",
 "https://docs.whop.com/openapi.json",
 "https://docs.whop.com/openapi/api-v1-native.yaml",
]
for u in cands:
    try:
        req = urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0","Accept":"*/*"})
        r = urllib.request.urlopen(req, timeout=45)
        d = r.read()
        print(u, r.status, r.headers.get("content-type"), len(d), d[:60])
    except Exception as e:
        print(u, "ERR", repr(e)[:150])
