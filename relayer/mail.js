// Same module as cross-chain-sponsor/mail.js (ChainIntegrate): the same SMTP settings and environment file.
// Email through the SMTP settings in the environment (EnvironmentFile in the systemd units):
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, NOTIFICATION_EMAIL (the operator)
"use strict";

function smtpReady() {
  const env = process.env;
  return ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"].every((k) => env[k]);
}

// `to` defaults to the operator (NOTIFICATION_EMAIL).
async function sendMail({ to, subject, text, attachments }) {
  const env = process.env;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) if (!env[k]) throw new Error(`missing ${k} in the environment`);
  const dest = to || env.NOTIFICATION_EMAIL;
  if (!dest) throw new Error("missing NOTIFICATION_EMAIL in the environment");
  const nodemailer = require("nodemailer");
  const t = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), secure: String(env.SMTP_SECURE || "true") === "true",
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  await t.sendMail({ from: env.SMTP_FROM, to: dest, subject, text, attachments });
}

module.exports = { sendMail, smtpReady };
