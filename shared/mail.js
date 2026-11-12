"use strict";
// The e-mail that goes with a document. The phone signs it with the same key that signed the
// document, so that the relayer sends only the e-mail its author meant, for that operation only.
// It is bound to the operation's EIP-712 digest (not to its signature), so the phone signs the
// document and the e-mail together, with one fingerprint.

const { keccak256, toUtf8Bytes, getAddress, getBytes, decodeBase64 } = require("ethers");
// No Buffer: this file also runs in the app's WebView.

const LIMITS = { maxRecipients: 10, maxSubject: 200, maxText: 20000, maxAttachmentBytes: 400 * 1024 };
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/**
 * Checks and normalizes an e-mail: { to: [addresses], subject, text, attachment?: { filename, base64 } }.
 * The only attachment allowed is one PDF. Throws with the reason.
 */
function validateMail(m) {
  if (!m || typeof m !== "object") throw new Error("mail: not an object");
  const to = [...new Set((Array.isArray(m.to) ? m.to : []).map((a) => String(a).trim().toLowerCase()))];
  if (to.length === 0 || to.length > LIMITS.maxRecipients) throw new Error(`mail: 1 to ${LIMITS.maxRecipients} recipients`);
  for (const a of to) if (a.length > 254 || !EMAIL.test(a)) throw new Error(`mail: "${a}" is not an e-mail address`);
  const subject = String(m.subject || "").trim();
  if (!subject || subject.length > LIMITS.maxSubject || /[\r\n]/.test(subject)) throw new Error("mail: invalid subject");
  const text = String(m.text || "");
  if (!text.trim() || text.length > LIMITS.maxText) throw new Error("mail: invalid text");
  const out = { to, subject, text };
  if (m.attachment !== undefined && m.attachment !== null) {
    const { filename, base64 } = m.attachment;
    if (typeof filename !== "string" || !/^[\w .()-]{1,80}\.pdf$/i.test(filename)) throw new Error("mail: the attachment must be a .pdf file name");
    if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("mail: attachment is not base64");
    const bytes = decodeBase64(base64);
    if (bytes.length > LIMITS.maxAttachmentBytes) throw new Error("mail: attachment too large");
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("mail: the attachment is not a PDF");
    out.attachment = { filename, base64 };
  }
  return out;
}

/**
 * What the phone signs (as a personal message): the hash of the registry, the operation's EIP-712
 * digest and the e-mail. Bound to the operation, the e-mail cannot be reused with another one.
 */
function mailDigest(registry, operationDigest, mail) {
  const m = validateMail(mail);
  const canonical = JSON.stringify({
    v: 1,
    registry: getAddress(registry).toLowerCase(),
    operation: String(operationDigest).toLowerCase(),
    to: m.to,
    subject: m.subject,
    text: m.text,
    attachment: m.attachment ? { filename: m.attachment.filename, hash: keccak256(decodeBase64(m.attachment.base64)) } : null,
  });
  return keccak256(toUtf8Bytes(canonical));
}

/** Signs the e-mail with a wallet (tests, tools); the app signs `hashMessage(mailDigest)` natively. */
async function signMail(wallet, registry, operationDigest, mail) {
  return wallet.signMessage(getBytes(mailDigest(registry, operationDigest, mail)));
}

module.exports = { MAIL_LIMITS: LIMITS, validateMail, mailDigest, signMail };
