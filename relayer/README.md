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
| `GET /gcr/info` | | `{ relayer, chainId, factory, balance, mail, limits }` |
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
  sent. Gas limit: the estimate plus 25%, never more than 16 million.
- The same signed operation again returns the same transaction (and sends no second e-mail).
- Limits: requests per IP per minute, operations per registry per day; requests up to 700 KB; a
  browser `Origin`, when present, must be in `allowedOrigins` (the app's).

## The e-mail

- Sent only after the document's transaction is confirmed, through the same SMTP settings as the
  other ChainIntegrate services (`/etc/gcr-relayer/smtp.env`, same values as Cross_Chain's).
- The phone signs the e-mail (recipients, subject, text, optional PDF) together with the operation's
  signature (`shared/mail.js`): the relayer sends only the e-mail that the phone that signed the
  document wrote, for that document only. 1 to 10 recipients, one PDF of at most 400 KB.
- The log records that an e-mail was sent and to how many recipients, never the addresses or the content.
- When the relayer's balance falls below `minBalanceWarn`, it logs a warning and e-mails
  `NOTIFICATION_EMAIL` (at most once a day).

## Install on the server

Like Cross_Chain's relayer: its own clone outside the web root, its key and configuration in `/etc`.

**1. User and a clone with only `relayer/` and `shared/`.**

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gcr-relayer
sudo git clone --filter=blob:none --no-checkout https://github.com/ChainIntegrate/gas-cylinder-registry.git /opt/gas-cylinder-registry
cd /opt/gas-cylinder-registry
sudo git sparse-checkout set --no-cone '/relayer/' '/shared/'
sudo git checkout main
cd relayer && sudo npm ci --omit=dev
```

**2. Key and configuration**, readable only by the service user.

```bash
sudo install -d -m 700 -o gcr-relayer -g gcr-relayer /etc/gcr-relayer
sudo -u gcr-relayer node /opt/gas-cylinder-registry/relayer/relay.js new-key /etc/gcr-relayer/relayer.key
sudo install -m 600 -o gcr-relayer -g gcr-relayer /opt/gas-cylinder-registry/relayer/config.example.json /etc/gcr-relayer/config.json
sudo nano /etc/gcr-relayer/config.json        # factory: the address from the owner tools' deploy-factory
```

The service refuses to start if the key file is readable by other users, if the RPC is on another
chain, or if there is no contract at the factory.

**3. SMTP**: the same values as `/etc/crosschain-relayer/smtp.env`.

```bash
sudo install -m 600 -o gcr-relayer -g gcr-relayer /etc/crosschain-relayer/smtp.env /etc/gcr-relayer/smtp.env
```

**4. Fund the relayer** with LYX on LUKSO (`new-key` printed its address). A new cylinder costs about
460,000 gas, a movement about 60,000.

**5. Service.**

```bash
sudo cp /opt/gas-cylinder-registry/relayer/gcr-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gcr-relayer
journalctl -u gcr-relayer -n 20     # "relayer 0x… on chain 42, balance …, mail on" and "listening on http://127.0.0.1:8789"
```

**6. Web server: pass `/gcr/` to the service**, in the same site as `/relay/`.

nginx:

```nginx
location /gcr/ {
    proxy_pass http://127.0.0.1:8789;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 700k;
}
```

Apache (`<VirtualHost *:443>`, with `proxy` and `proxy_http` enabled):

```apache
ProxyPass        /gcr/ http://127.0.0.1:8789/gcr/
ProxyPassReverse /gcr/ http://127.0.0.1:8789/gcr/
```

(Apache adds the client's address to `X-Forwarded-For`; the service uses the last entry for its
per-IP limit.)

**7. Check.**

```bash
curl -s https://crosschain-lukso.chainintegrate.it/gcr/info
```

Then set `"relayer": "https://crosschain-lukso.chainintegrate.it"` in the owner tools' `gcr-registry.json`:
from then on the owner's operations go through the relayer and ChainIntegrate's key file is needed only
to deploy the factory and create registries.

## Update, logs, stop

```bash
cd /opt/gas-cylinder-registry && sudo git pull && (cd relayer && sudo npm ci --omit=dev) && sudo systemctl restart gcr-relayer
journalctl -u gcr-relayer -f
sudo systemctl stop gcr-relayer
```
