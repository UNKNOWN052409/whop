import urllib.request
u = "https://cdn.jsdelivr.net/npm/@whop/sdk@2.2.0/dist/esm/helpers/verifyWebhook.mjs"
req = urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"})
src = urllib.request.urlopen(req, timeout=60).read().decode("utf-8","replace")
open("whop-research/verifyWebhook.mjs","w",encoding="utf-8").write(src)
print(src)
