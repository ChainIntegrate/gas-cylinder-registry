# Publishing GasTrace on LUKSO

Everything GasTrace serves lives under **gastrace.chainintegrate.it**, on the same server as Cross_Chain and
account.chainintegrate.it: the admin page (static files, `admin/www`) and the relayer (`/gcr/`, a local
service on port 8789). The steps are in order; each says where it runs.

**Done for the demo on 2026-11-13** (steps 0 to 5; step 6, the extension's catalog, is pending in up-onboarding): DNS `gastrace` →
`31.14.140.170`; factory `0xA128e7162fa8Dc779bf31EF569F06B53a499A50e` (block 8774243) and register
implementation `0x3075ED17F09E0006cECC0D7e67Fe7E7A4Dc95b00`, both verified on the explorer; Argonia
Gas Tecnici's register `0xEae1a8B84977694e5c9925028a23599bc345b801` (block 8774282), owned by its
ChainIntegrate account `0xC335aFd1d95fA790DE419e9BCe482d9B8BC1D773`; relayer
`0xDC84b301024A4d1735Ad59616023e0C74F07f100` on port 8789; the site with its certificate, every check
of step 5 as expected; app release v0.2.0.

| Part | Where | Port |
|---|---|---|
| Admin page | nginx, root `/var/www/gas-cylinder-registry/admin/www` | none (static) |
| Relayer | systemd `gcr-relayer`, `127.0.0.1:8789`, nginx `/gcr/` | 8789 (local only) |
| Already on the server | Cross_Chain relayer 8787, sponsor service 8788, up-onboarding creation service 8811 | |

## 0. Checks on the server

```bash
sudo ss -ltnp | grep -E ':8789\b' || echo "8789 free"     # must print "8789 free"
sudo ss -ltnp                                              # what listens today, for reference
node -v                                                    # v20 or later, in /usr/bin (not under /root or /home)
nginx -v                                                   # 1.18 or later
```

If 8789 is taken, pick another free port and use it in step 4 (`listen.port` in the relayer's config) and
step 5 (`proxy_pass` in the site file).

## 1. DNS

An `A` record (and `AAAA` if the server has IPv6) for `gastrace.chainintegrate.it`, pointing to the same
address as `crosschain-lukso.chainintegrate.it`.

## 2. Factory and register (on your computer, owner tools)

From a clone of this repository, with Node.js 20 or later: `npm ci`. ChainIntegrate's key file
(`chainintegrate.keystore.json`, see `docs/owner-tools.md`) needs a little LYX: the factory costs a few
million gas once, a register about half a million.

```bash
node scripts/owner.js deploy-factory --network lukso
node scripts/owner.js create-registry --network lukso --name "<the company's name>" --symbol <SYMBOL> \
  --owner <the ChainIntegrate account's address> --language it
```

- `--owner` is the address of the ChainIntegrate account that will manage the register from the page.
- The data password is asked twice; the 24-word recovery code is shown once: write it down.
- `gcr-registry.json` now holds the factory's address and block: they go into the page and the app (step 3).

### Publish the contracts' source on LUKSO's explorer (once, after the factory)

Anyone can then check that the deployed contracts are this repository's. It needs the development
dependencies (the compiler) in the owner tools' folder:

```bash
cd ~/gastrace-tools && git pull && npm ci
npx hardhat run --network luksoMainnet scripts/verify-lukso.js
```

It verifies the registry implementation and the factory (registries are clones of the implementation: the
explorer shows them as its proxies) and prints their explorer pages.

## 3. The factory into the page and the app (in this repository)

`admin/admin-config.json`: `factory` and `factoryBlock` from `gcr-registry.json`. Then:

```bash
node scripts/build-admin.js     # admin/www, committed: the server serves it from its clone, with no build
git add admin && git commit -m "Admin page: LUKSO factory" && git push
```

`app/app-config.json` needs no factory (the phone learns its register from the setup code); after this
step a new app release (tag `v0.2.0`) gives the drivers the APK that talks to gastrace.chainintegrate.it.

## 4. The relayer (on the server)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gcr-relayer
sudo git clone --filter=blob:none --no-checkout https://github.com/ChainIntegrate/gas-cylinder-registry.git /var/www/gas-cylinder-registry
cd /var/www/gas-cylinder-registry
sudo git sparse-checkout set --no-cone '/relayer/' '/shared/' '/admin/www/' '/tools/nginx/'
sudo git checkout main
cd relayer && sudo npm ci --omit=dev

sudo install -d -m 700 -o gcr-relayer -g gcr-relayer /etc/gcr-relayer
sudo -u gcr-relayer node /var/www/gas-cylinder-registry/relayer/relay.js new-key /etc/gcr-relayer/relayer.key   # prints the relayer's address
sudo install -m 600 -o gcr-relayer -g gcr-relayer /var/www/gas-cylinder-registry/relayer/config.example.json /etc/gcr-relayer/config.json
sudo nano /etc/gcr-relayer/config.json            # "factory": the address from step 2
```

The RPC: ChainIntegrate's node with an access key made for this service only (as up-onboarding's), in a file
only the service reads; or LUKSO's public node (`https://rpc.mainnet.lukso.network`) for a start.

```bash
sudo install -m 600 -o gcr-relayer -g gcr-relayer /dev/null /etc/gcr-relayer/rpc-url
sudo nano /etc/gcr-relayer/rpc-url                # one line: the RPC URL
sudo install -m 600 -o gcr-relayer -g gcr-relayer /etc/crosschain-relayer/smtp.env /etc/gcr-relayer/smtp.env
sudo cp /var/www/gas-cylinder-registry/relayer/gcr-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gcr-relayer
sudo journalctl -u gcr-relayer -n 5               # "relayer 0x… on chain 42, …, mail on", "listening on http://127.0.0.1:8789"
curl -s http://127.0.0.1:8789/gcr/info
```

Send the relayer's address a few LYX (it pays every operation; it e-mails when below 0.5 LYX).

## 5. The site (on the server)

Certificate first: nginx refuses an `ssl` server without it, so first the port 80 block alone.

```bash
sudo sed -n '/^server {/,/^}/p;/^}/q' /var/www/gas-cylinder-registry/tools/nginx/gastrace.chainintegrate.it.conf | sudo tee /etc/nginx/sites-available/gastrace.chainintegrate.it
sudo ln -sf /etc/nginx/sites-available/gastrace.chainintegrate.it /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/gas-cylinder-registry/admin/www -d gastrace.chainintegrate.it

sudo cp /var/www/gas-cylinder-registry/tools/nginx/gastrace-security-headers.conf /etc/nginx/snippets/
sudo cp /var/www/gas-cylinder-registry/tools/nginx/gastrace.chainintegrate.it.conf /etc/nginx/sites-available/gastrace.chainintegrate.it
sudo nginx -t && sudo systemctl reload nginx
```

Checks (from the server, through nginx on the machine itself):

```bash
R="--resolve gastrace.chainintegrate.it:443:127.0.0.1 --resolve gastrace.chainintegrate.it:80:127.0.0.1"
curl -sI $R https://gastrace.chainintegrate.it/ | grep -i -E "^HTTP|content-security-policy|x-frame"   # 200
curl -s  $R https://gastrace.chainintegrate.it/gcr/info                                               # the relayer's info
for u in /.git/config /admin-config.json /../relayer/relay.js; do curl -s $R -o /dev/null -w "$u %{http_code}\n" https://gastrace.chainintegrate.it$u; done   # 404 each
curl -s $R -o /dev/null -w "%{http_code} %{redirect_url}\n" http://gastrace.chainintegrate.it/      # 301 to https
```

## 6. The extension's catalog (up-onboarding, in its own conversation)

In `extension/shared/catalog.js`, project `gas-cylinders`: `CYLINDER_FACTORY` = the factory's address and
`sites: ["gastrace.chainintegrate.it"]`; then a release of the extension (a released version never changes)
and its update on the owner's computer. Until then the extension does not serve the page.

## 7. First use

1. https://gastrace.chainintegrate.it/ → "Accedi con ChainIntegrate Account", the data password.
2. **Settings**: the company's name and the supplier's e-mails. **Customers**: the customers and refill plants.
3. **Phones**: the driver's app scans the setup QR, shows its code; authorize it; type the data password on the phone.

## Every update

```bash
cd /var/www/gas-cylinder-registry && sudo git pull --ff-only
(cd relayer && sudo npm ci --omit=dev) && sudo systemctl restart gcr-relayer      # when relayer/ or shared/ changed
```

The page is served from the clone (`admin/www`) with `Cache-Control: no-cache`: a pull is enough.
