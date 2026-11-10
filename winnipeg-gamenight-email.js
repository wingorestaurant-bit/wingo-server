// Winnipeg Jets game night email (Tuesday, Nov 10 2026), sent from /winnipeg-admin.
// Each recipient gets their own greeting and unsubscribe link.
const ID = 'wpg-gamenight-2026-11-10';
const LABEL = 'Game Night: Tonight we go blue (Nov 10)';
const SUBJECT = 'Tonight we go blue \u{1F499} Game night wing deals inside';
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const deal = (icon, name, what, price, was, flag) => `
    <tr><td style="padding:0 0 12px;">
      <table role="presentation" style="width:100%;border-collapse:separate;background:#0B2A57;border:2px solid ${flag ? '#FFE56A' : '#3B5B8C'};border-radius:14px;">
        <tr>
          <td style="padding:16px 6px 16px 16px;width:44px;font-size:34px;line-height:1;vertical-align:middle;">${icon}</td>
          <td style="padding:14px 8px;vertical-align:middle;color:#fff;">
            <div style="font-size:19px;font-weight:900;letter-spacing:1px;">${name}${flag ? ` <span style="background:#FFE56A;color:#041E42;font-size:10px;letter-spacing:1px;padding:2px 6px;border-radius:4px;vertical-align:middle;">${flag}</span>` : ''}</div>
            <div style="font-size:14px;color:#DCE6F5;line-height:1.45;margin-top:3px;">${what}</div>
          </td>
          <td style="padding:14px 16px 14px 4px;text-align:right;vertical-align:middle;white-space:nowrap;">
            <div style="font-size:26px;font-weight:900;color:#FFE56A;line-height:1;">$${price}</div>
            <div style="font-size:12px;color:#8FA3BF;text-decoration:line-through;margin-top:4px;">$${was}</div>
          </td>
        </tr>
      </table>
    </td></tr>`;

function render({ name, unsubUrl }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const greeting = first ? `Hey ${esc(first)}! \u{1F44B}` : 'Hey, you! \u{1F44B}';
  unsubUrl = esc(unsubUrl);
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tonight we go blue</title></head>
<body style="margin:0;padding:0;background:#dfe6f0;">
<div style="display:none;max-height:0;overflow:hidden;">Jets game night specials: 27 wings + curly fries $41.99, up to 90 wings for the whole crew. Pickup on Dakota St.</div>
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#F4F7FB;">

  <!-- header -->
  <div style="background:#0D0D0D;padding:18px;text-align:center;border-bottom:4px solid #A2AAAD;">
    <h1 style="color:#E8190A;margin:0;letter-spacing:2px;font-size:34px;">WING<span style="color:#fff;">-O</span></h1>
    <p style="color:#A2AAAD;margin:6px 0 0;font-size:12px;letter-spacing:4px;">MORE THAN WINGS · WINNIPEG</p>
  </div>

  <!-- hero -->
  <div style="background:#041E42;background-image:linear-gradient(180deg,#0B4FA8,#041E42);color:#fff;text-align:center;padding:30px 20px 28px;border-bottom:6px solid #C8102E;">
    <p style="margin:0;font-size:13px;letter-spacing:4px;font-weight:bold;color:#A2AAAD;">🏒 JETS GAME NIGHT · TONIGHT</p>
    <p style="margin:14px 0 0;font-size:44px;font-weight:900;line-height:1;letter-spacing:1px;">TONIGHT<br>WE GO <span style="color:#7FB2FF;">BLUE</span> 💙</p>
    <p style="margin:14px 0 0;font-size:16px;color:#DCE6F5;">Jets vs New Jersey Devils · Puck drops 7 PM</p>
  </div>

  <!-- intro -->
  <div style="padding:24px 24px 4px;color:#0D1B2E;font-size:16px;line-height:1.6;">
    <p style="font-size:20px;font-weight:bold;margin:0 0 10px;">${greeting}</p>
    <p style="margin:0;">Game night = wing night. We made <b>special deals just for tonight</b>, so grab the crew, order ahead and don't miss a single shift. 👇</p>
  </div>

  <!-- deals -->
  <div style="padding:18px 24px 4px;">
    <table role="presentation" style="width:100%;border-collapse:collapse;">
      ${deal('🎩', 'HAT TRICK HEAT', '27 wings (3 flavours)<br>+ large curly fries', '41.99', '47.98')}
      ${deal('⚡', 'POWER PLAY PACK', '36 wings (4 flavours)<br>+ large curly fries + mozza sticks', '62.99', '70.47')}
      ${deal('🥅', 'THE WHOLE BENCH', '90 wings (10 flavours) + 2 large curly fries + mozza sticks + jalapeño poppers', '145.99', '158.94', 'FEEDS 8–10')}
    </table>
    <p style="margin:2px 0 0;text-align:center;font-size:13px;color:#4B5D78;">Pick any of our 135+ flavours · Pickup only · Tonight only</p>
  </div>

  <!-- CTA -->
  <div style="padding:16px 24px 4px;text-align:center;">
    <a href="https://wingorestaurants.com/#game-night" style="display:inline-block;background:#C8102E;color:#fff;text-decoration:none;font-weight:bold;font-size:18px;padding:16px 34px;border-radius:30px;border-bottom:4px solid #7d0a1c;">ORDER GAME NIGHT DEALS 🏒</a>
    <p style="font-size:13px;color:#4B5D78;margin:12px 0 0;">Or call <a href="tel:+12042554055" style="color:#4B5D78;font-weight:bold;">204-255-4055</a> and we'll have it ready.</p>
  </div>

  <!-- details -->
  <div style="padding:20px 24px 4px;">
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;color:#0D1B2E;background:#E3EAF4;border-radius:12px;">
      <tr><td style="padding:12px 14px 6px;width:86px;"><b>📍 Pickup</b></td><td style="padding:12px 14px 6px 0;">1530 Dakota St, Unit 4001, Winnipeg</td></tr>
      <tr><td style="padding:6px 14px;"><b>🕚 Open</b></td><td style="padding:6px 14px 6px 0;">11 AM to 1 AM tonight</td></tr>
      <tr><td style="padding:6px 14px 12px;"><b>📞 Call</b></td><td style="padding:6px 14px 12px 0;"><a href="tel:+12042554055" style="color:#C8102E;font-weight:bold;text-decoration:none;">204-255-4055</a></td></tr>
    </table>
  </div>

  <!-- sign off -->
  <div style="padding:22px 24px 8px;color:#0D1B2E;font-size:16px;line-height:1.6;">
    <p style="margin:0;font-weight:bold;">Go Jets Go! See you tonight. 💙</p>
    <p style="margin:16px 0 0;">🔥 <b>The Sauce Boss</b><br><span style="color:#888;font-size:13px;">Wing-O Restaurants · More Than Wings</span></p>
    <p style="margin:18px 0 0;font-size:15px;background:#FFE56A;padding:12px 14px;border-radius:10px;"><b>P.S.</b> Rather eat in? It's also <b>All You Can Eat Tuesday</b> at Dakota St, 5 to 10 PM. Unlimited wings for $28.99. The record is <b>96 wings</b>. 🏆</p>
  </div>

  <div style="padding:16px 24px 20px;color:#888;font-size:12px;text-align:center;">You signed up at wingorestaurants.com/winnipeg. <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></div>
</div>
</body>
</html>`;
}

module.exports = { ID, LABEL, SUBJECT, render };
