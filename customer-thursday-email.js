// Thursday wing deal email (buy one order of wings, 2nd 50% off), sent to the whole
// customer list from /email-admin. The design lives in marketing/wingo-thursday-email.html;
// each recipient gets their own first name and unsubscribe link.
const fs = require('fs');
const path = require('path');

const ID = 'all-thursday-wings-2026-11';
const LABEL = 'Wing-O Thursday: 2nd order 50% off';
const SUBJECT = '\u{1F357} Wing-O Thursday: your 2nd order is 50% off';
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'marketing', 'wingo-thursday-email.html'), 'utf8');
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render({ name, unsubUrl }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return TEMPLATE
    .split('{{FIRST_NAME}}').join(first ? esc(first) : 'wing fan')
    .split('{{UNSUBSCRIBE_URL}}').join(esc(unsubUrl));
}

module.exports = { ID, LABEL, SUBJECT, render };
