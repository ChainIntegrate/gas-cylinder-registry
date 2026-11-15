# relayer: sends the signed operations and pays the gas

A small Node.js service on ChainIntegrate's server (the same server as Cross_Chain's relayer). Phones
and owners **sign** their operations; this service **sends** them to their registry on LUKSO and pays
the gas with its own key, so that nobody at the gas supplier ever holds LYX. After a document's
transaction is confirmed, it sends the document's e-mail.

## What the relayer key can do

Nothing inside a registry: it is neither an owner nor an operator anywhere. It only holds the LYX that
pays the gas. A stolen key can spend that balance and nothing else. The registry refuses any operation
without a valid signature of its owner or of an authorized phone, so the relayer cannot forge or alter
anything; at worst it can fail to send, and any account with LYX can then send the same signed
operation.

## Endpoints (behind the web server, under `/gcr/`)

| Method and path | Body | Answer |
|---|---|---|
| `GET /gcr/info` | | `{ relayer, chainId, factory, balance, mail, limits, app? }`; `app: { version, url }` is the latest released app, when announced ([below](#announce-a-new-app-release)) |
| `POST /gcr/document` | `{ registry, payload, signer, nonce, deadline, signature, mail?, mailSignature? }` | `{ hash }`, or `{ error, detail? }` with 4xx |
| `POST /gcr/owner` | `{ registry, method, args }`, `method` one of `setOperatorSigned`, `setDataSigned`, `transferOwnershipSigned`, `acceptOwnershipSigned` | `{ hash }`, or `{ error, detail? }` |
| `GET /gcr/status?hash=0x…` | | `{ state: pending/confirmed/failed, blockNumber, mail: none/pending/sent/failed/not_sent }` for the transactions it sent (the last 5,000) |

Numbers (`nonce`, `deadline`, owner arguments) are decimal strings. `detail.error` names the
registry's refusal when there is one (for example `StaleValue`: a cylinder changed since the phone
read it; `DocumentPartAlreadyRecorded`: the same document number was sent before).

## What it accepts

- Registries created by the configured factory only (`isRegistry`), so a look-alike contract cannot
  spend its gas.
- Documents signed by the registry's owner or an authorized phone, with at most 25 new cylinders and
  60 data updates per operation, a document of at most 16 KB, values of at most 1 KB.
- Operations that succeed in simulation; the registry's error is returned otherwise and nothing is
  sent. Gas limit: the estimate plus 25%, never more than 16 million (when a node's estimate fails
  after a successful simulation, the 16 million cap; only the gas used is paid).
- The same signed operation again returns the same transaction (and sends no second e-mail).
- Limits: requests per IP per minute (`perIpPerMinute`), checked first, before any call to the node;
  operations per registry per day (`perRegistryPerDay`), counted only for an operation that passed
  every check and the simulation, when it is sent, so malformed or badly signed requests naming a
  registry cannot use up its day (and the same operation sent again is not counted twice). An address
  that is not one of the factory's registries is remembered for ten minutes. The registries' daily
  counts are kept in the journal across restarts; the per-IP counts live in memory. Requests up to 700 KB; a browser `Origin`, when present, must be in
  `allowedOrigins` (the app's).

## The e-mail

- Sent only after the document's transaction is confirmed, through the same SMTP settings as the
  other ChainIntegrate services (`/etc/gcr-relayer/smtp.env`, same values as Cross_Chain's).
- The phone does not send an e-mail's text: it signs the document's facts (recipients, language,
  company, customer, kind, number, date, cylinders, warnings), with the same fingerprint as the
  document and bound to it (`shared/mail.js`), and the relayer writes the e-mail from a fixed template
  (`renderMail`, the date in `mailTimeZone`, default Europe/Rome). No free text, no attachment, no
  unknown field; 1 to 8 recipients; a registry's documents send at most `mailsPerRegistryPerDay` (100)
  e-mails a day, beyond which the document is recorded and its e-mail reported as not sent (review
  G-03). The app's "send from the phone" uses the same template.
- The log records that an e-mail was sent and to how many recipients, never the addresses or the content.
- When the relayer's balance falls below `minBalanceWarn`, it logs a warning and e-mails
  `NOTIFICATION_EMAIL` (at most once a day).

## Install on the server

The whole sequence, with the admin page and the site, is in [DEPLOY.md](../DEPLOY.md). The relayer's part:

Its own clone in `/var/www/gas-cylinder-registry`, as up-onboarding's (nginx serves only `admin/www` from it), its key and configuration in `/etc`.

**1. User and a clone with only `relayer/` and `shared/`.**

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gcr-relayer
sudo git clone --filter=blob:none --no-checkout https://github.com/ChainIntegrate/gas-cylinder-registry.git /var/www/gas-cylinder-registry
cd /var/www/gas-cylinder-registry
sudo git sparse-checkout set --no-cone '/relayer/' '/shared/' '/admin/www/' '/tools/nginx/'
sudo git checkout main
cd relayer && sudo npm ci --omit=dev
```

**2. Key and configuration**, readable only by the service user.

```bash
sudo install -d -m 700 -o gcr-relayer -g gcr-relayer /etc/gcr-relayer
sudo -u gcr-relayer node /var/www/gas-cylinder-registry/relayer/relay.js new-key /etc/gcr-relayer/relayer.key
sudo install -m 600 -o gcr-relayer -g gcr-relayer /var/www/gas-cylinder-registry/relayer/config.example.json /etc/gcr-relayer/config.json
sudo nano /etc/gcr-relayer/config.json        # factory: the address from the owner tools' deploy-factory
sudo install -m 600 -o gcr-relayer -g gcr-relayer /dev/null /etc/gcr-relayer/rpc-url
sudo nano /etc/gcr-relayer/rpc-url            # one line: the RPC URL (ChainIntegrate's node with its key, or LUKSO's public one)
```

The service refuses to start if the key file is readable by other users, if the node answers another
chain (`eth_chainId`, asked), or if the factory does not answer as GasTrace's factory with its
implementation in place.

**3. SMTP**: the same values as `/etc/crosschain-relayer/smtp.env`.

```bash
sudo install -m 600 -o gcr-relayer -g gcr-relayer /etc/crosschain-relayer/smtp.env /etc/gcr-relayer/smtp.env
```

**4. Fund the relayer** with LYX on LUKSO (`new-key` printed its address). A new cylinder costs about
460,000 gas, a movement about 60,000.

**5. Service.**

```bash
sudo cp /var/www/gas-cylinder-registry/relayer/gcr-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gcr-relayer
journalctl -u gcr-relayer -n 20     # "relayer 0x… on chain 42, balance …, mail on" and "listening on http://127.0.0.1:8789"
```

**6. Web server.** The service is published as `https://gastrace.chainintegrate.it/gcr/`, in the same
nginx site as the admin page: `tools/nginx/gastrace.chainintegrate.it.conf` (its `location /gcr/` passes
to `127.0.0.1:8789` and sets `X-Real-IP` for the per-IP limit). The site's installation, certificate
first, is step 5 of [DEPLOY.md](../DEPLOY.md).

**7. Check.**

```bash
curl -s https://gastrace.chainintegrate.it/gcr/info
```

For an owner that uses ChainIntegrate's command-line tools with a key file, set
`"relayer": "https://gastrace.chainintegrate.it"` in their `gcr-registry.json`: owner operations then go
through the relayer too.

## The journal (what survives a restart)

The relayer keeps on disk (`stateFile`, by default `/var/lib/gcr-relayer/journal.json`, a directory
systemd makes for the service: `StateDirectory=gcr-relayer` in the unit) what it sent in the last seven
days: each transaction's state, the operation it carried, the registries' daily counts, and an e-mail
until it is sent; the e-mail's content leaves the file once sent (review A07). At start it reads the
journal back, waits for the transactions left pending and sends the e-mails left unsent; `/gcr/status`
answers for them as before. An e-mail can leave twice if the relayer stops between the SMTP server's
answer and the journal's update: a duplicate rather than a loss. The file is readable by the service only
(mode 600, directory 700).

After updating to a version with the journal, install the unit once more:

```bash
sudo cp /var/www/gas-cylinder-registry/relayer/gcr-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart gcr-relayer
ls -la /var/lib/gcr-relayer/        # journal.json appears after the first operation
```

## Announce a new app release

The app asks `/gcr/info` when it is unlocked and when the network returns; when `app.version` is newer
than its own, it shows "A new version of GasTrace is available" with a Download button that opens the
APK's link in the browser. The relayer reads the announcement from the file named by `appReleaseFile` in
`config.json` (`/etc/gcr-relayer/app-release.json`), at every request: updating it needs no restart.

```bash
sudo install -m 644 -o gcr-relayer -g gcr-relayer /var/www/gas-cylinder-registry/relayer/app-release.example.json /etc/gcr-relayer/app-release.json
sudo nano /etc/gcr-relayer/app-release.json    # version and the release's APK link
curl -s https://gastrace.chainintegrate.it/gcr/info    # "app": { "version": …, "url": … }
```

```json
{ "version": "0.2.4", "url": "https://github.com/ChainIntegrate/gas-cylinder-registry/releases/download/v0.2.4/gastrace-v0.2.4.apk" }
```

The relayer announces only a `x.y.z` version with a link to that version's APK in this repository's
releases (`…/releases/download/v<version>/….apk`); anything else, a missing file or invalid JSON
announces nothing. Write it only after the release's build has attached the APK.

## Update, logs, stop

```bash
cd /var/www/gas-cylinder-registry && sudo git pull && (cd relayer && sudo npm ci --omit=dev) && sudo systemctl restart gcr-relayer
sudo cp relayer/gcr-relayer.service /etc/systemd/system/ && sudo systemctl daemon-reload   # when the unit changed
journalctl -u gcr-relayer -f
sudo systemctl stop gcr-relayer
```
