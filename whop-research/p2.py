import urllib.request, json
def get(u):
    req = urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8","replace")
# version of standard-webhooks used by @whop/sdk
try:
    pkg = json.loads(get("https://cdn.jsdelivr.net/npm/@whop/sdk@2.2.0/package.json"))
    print("DEPS:", json.dumps(pkg.get("dependencies", {}), indent=1))
except Exception as e:
    print("pkg fail", repr(e)[:200])
