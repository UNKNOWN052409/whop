import urllib.request, json
def get(u):
    req = urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8","replace")
try:
    d = json.loads(get("https://data.jsdelivr.com/v1/packages/npm/@whop/sdk@2.2.0?structure=flat"))
    files = [f["name"] for f in d.get("files",[])]
    print("TOTAL", len(files))
    for f in files:
        lf = f.lower()
        if "helper" in lf or "webhook" in lf or "verify" in lf or "sign" in lf:
            print("HIT", f)
except Exception as e:
    print("FAIL", repr(e)[:400])
