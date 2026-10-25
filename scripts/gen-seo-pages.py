#!/usr/bin/env python3
"""Generate Wing-O SEO pages into public/: location pages, guides, /menu, /flavours and llms.txt.

    python3 scripts/gen-seo-pages.py

The menu and flavour lists are read from public/index.html (the MENU and FLAVORS objects), so
re-run this after changing prices or flavours on the ordering page.
"""
import json, html, urllib.parse, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public')
SITE = 'https://wingorestaurants.com'
UPDATED = '2026-10-25'

CITY_HOURS = [
    (['Monday', 'Tuesday', 'Wednesday'], '11:00', '01:00', 'Mon–Wed', '11 AM – 1 AM'),
    (['Thursday', 'Friday', 'Saturday', 'Sunday'], '11:00', '03:00', 'Thu–Sun', '11 AM – 3 AM'),
]
BEACH_HOURS = [
    (['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], '11:00', '22:00', 'Every day', '11 AM – 10 PM'),
]

LOCS = [
    dict(slug='regina-albert-st', key='albert-st', short='Albert Street',
         name='Wing-O Albert Street', street='#3 - 155 Albert St N', city='Regina',
         phone='639-997-0553', lat=50.4501, lng=-104.6178, hours=CITY_HOURS, delivery=True,
         title='Chicken Wings & Fried Chicken, Albert St N Regina | Wing-O',
         desc='Wing-O Albert Street: crispy chicken wings, boneless wings and fried chicken burgers at 155 Albert St N, Regina. 135+ flavours, open till 3am Thu–Sun. Order online.',
         h1='Chicken Wings on Albert Street, Regina',
         area='north-central Regina',
         intro=("Our Albert Street kitchen is where Wing-O started, and it's still where a lot of Regina "
                "comes for wings. You'll find us at <strong>#3 – 155 Albert St N</strong>, a quick drive "
                "from downtown, with pickup, delivery across Regina and late-night hours when the "
                "craving hits after midnight."),
         why=[("The original Wing-O", "This is the location that built the 135+ flavour vault — from Honey Garlic to Devil's Kiss."),
              ("Open late", "Open until 1 AM Monday to Wednesday and until 3 AM Thursday to Sunday."),
              ("Pickup or delivery", "Order online for pickup in about 20 minutes, or delivery anywhere in Regina for a flat $5.50.")]),
    dict(slug='regina-east', key='east-regina', short='East Regina',
         name='Wing-O East Regina', street='534 University Park Drive', city='Regina',
         phone='306-522-2114', lat=50.4282, lng=-104.5768, hours=CITY_HOURS, delivery=True,
         title='Chicken Wings & Fried Chicken in East Regina | Wing-O',
         desc='Wing-O East Regina at 534 University Park Drive: chicken wings, boneless wings, chicken fingers and fried chicken burgers. 135+ flavours, open till 3am Thu–Sun.',
         h1='Chicken Wings in East Regina',
         area="Regina's east end",
         intro=("Wing-O East brings the full 135+ flavour menu to <strong>534 University Park Drive</strong>, "
                "so the east side of Regina doesn't have to cross the city for proper wings. Grab a "
                "table, order pickup, or get it delivered."),
         why=[("Same 135+ flavours", "Every sauce and dry rub from the Wing-O vault, made fresh to order."),
              ("Open late", "Open until 1 AM Monday to Wednesday and until 3 AM Thursday to Sunday."),
              ("Pickup or delivery", "Order online for pickup in about 20 minutes, or delivery anywhere in Regina for a flat $5.50.")]),
    dict(slug='regina-beach', key='regina-beach', short='Regina Beach',
         name='Wing-O Regina Beach', street='110 Centre St', city='Regina Beach',
         phone='639-997-0553', lat=50.5786, lng=-105.0008, hours=BEACH_HOURS, delivery=False,
         title='Chicken Wings in Regina Beach, SK | Wing-O Centre Street',
         desc='Wing-O Regina Beach at 110 Centre St: crispy chicken wings, boneless wings and fried chicken, 135+ flavours. Open every day 11am–10pm. Order online for pickup.',
         h1='Chicken Wings in Regina Beach',
         area='Regina Beach and Last Mountain Lake',
         season=("Wing-O Regina Beach is a summer location and is closed for the season. "
                 "Our Regina locations on Albert Street and University Park Drive are open year-round."),
         intro=("Heading out to the lake? Wing-O Regina Beach is at <strong>110 Centre St</strong>, serving "
                "the same wings Regina lines up for — perfect for a day at Last Mountain Lake, a cabin "
                "weekend or a night in."),
         why=[("Lake-day wings", "Order ahead online and pick up on your way to the beach or the cabin."),
              ("Open every day", "11 AM to 10 PM, seven days a week."),
              ("Same 135+ flavours", "Every sauce and dry rub from the Wing-O vault, made fresh to order.")]),
]

CSS = """*{margin:0;padding:0;box-sizing:border-box;}
:root{--black:#0D0D0D;--ink:#1A1208;--paper:#F4EBD7;--paper-dark:#E8DCC1;--paper-line:#C8B89A;--red:#E8190A;--red-deep:#A80F00;--yellow:#F5A800;--font-head:'Oswald',sans-serif;--font-display:'Bebas Neue',sans-serif;--font-serif:'Playfair Display',serif;--font-body:'Inter',sans-serif;}
body{font-family:var(--font-body);background:var(--paper);color:var(--ink);line-height:1.7;}
nav{background:var(--black);padding:1rem 1.5rem;border-bottom:3px double var(--yellow);}
.nav-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:1rem;}
.nav-inner a{color:white;text-decoration:none;font-family:var(--font-display);font-size:1.4rem;letter-spacing:2px;}
.nav-inner a span{color:var(--red);}
.nav-inner .back{font-family:var(--font-head);font-size:.78rem;letter-spacing:2px;color:#888;text-transform:uppercase;}
.crumbs{max-width:900px;margin:0 auto;padding:.9rem 1.5rem 0;font-family:var(--font-head);font-size:.75rem;letter-spacing:1px;text-transform:uppercase;color:#888;}
.crumbs a{color:#888;text-decoration:none;}.crumbs a:hover{color:var(--red);}
.hero{background:linear-gradient(135deg,#0D0D0D,#1A1208);color:white;padding:3.5rem 1.5rem;text-align:center;border-bottom:3px double var(--yellow);}
.hero h1{font-family:var(--font-display);font-size:clamp(2.3rem,6vw,4.2rem);letter-spacing:3px;line-height:.98;margin-bottom:.5rem;}
.hero h1 span{color:var(--red);}
.hero p{font-family:var(--font-serif);font-style:italic;color:var(--yellow);font-size:1.1rem;max-width:640px;margin:1rem auto 0;}
.hero .btns{display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;margin-top:1.75rem;}
.btn{display:inline-block;background:var(--red);color:white;padding:.8rem 1.6rem;font-family:var(--font-display);font-size:1.1rem;letter-spacing:2px;text-decoration:none;border-radius:4px;text-transform:uppercase;box-shadow:0 4px 0 var(--red-deep);}
.btn:hover{background:var(--red-deep);}
.btn.ghost{background:transparent;border:2px solid var(--yellow);color:var(--yellow);box-shadow:none;}
.container{max-width:900px;margin:0 auto;padding:2.5rem 1.5rem 3rem;}
.post{background:white;border:1px solid var(--paper-line);border-radius:8px;padding:2rem;margin-bottom:1.5rem;box-shadow:0 4px 12px rgba(0,0,0,.05);}
.post-tag{display:inline-block;background:var(--red);color:white;padding:.3rem .85rem;font-family:var(--font-head);font-size:.7rem;letter-spacing:2px;text-transform:uppercase;border-radius:3px;margin-bottom:.75rem;font-weight:700;}
.post h2{font-family:var(--font-display);font-size:clamp(1.6rem,3.5vw,2.3rem);color:var(--ink);letter-spacing:1.5px;line-height:1.1;margin-bottom:.6rem;}
.post .meta{font-family:var(--font-head);font-size:.78rem;color:#888;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:1rem;}
.post p{margin-bottom:1rem;color:#444;font-size:1rem;line-height:1.7;}
.post p strong{color:var(--ink);}
.post h3{font-family:var(--font-display);font-size:1.4rem;color:var(--ink);letter-spacing:2px;margin:1.5rem 0 .75rem;border-left:4px solid var(--red);padding-left:.85rem;}
.post a{color:var(--red);text-decoration:none;font-weight:600;}
.post a:hover{text-decoration:underline;}
.post a.btn{color:white;}.post a.btn:hover{text-decoration:none;}
ul.bullet{padding-left:1.5rem;margin-bottom:1rem;}
ul.bullet li{padding:4px 0;color:#444;}
.callout{background:var(--paper);border:1px solid var(--paper-line);border-left:4px solid var(--yellow);padding:1rem 1.25rem;border-radius:6px;margin:1.25rem 0;}
.callout .label{font-family:var(--font-head);font-size:.72rem;color:var(--red);letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:.3rem;}
.info{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:1rem;margin:1rem 0 1.25rem;}
.info .box{background:var(--paper);border:1px solid var(--paper-line);border-radius:6px;padding:1rem 1.15rem;}
.info .label{font-family:var(--font-head);font-size:.72rem;color:var(--red);letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:.35rem;}
.info .val{color:var(--ink);font-size:1rem;line-height:1.5;}
.info .val a{color:var(--ink);font-weight:700;}
table.hours{border-collapse:collapse;width:100%;}
table.hours td{padding:.2rem 0;color:#333;}table.hours td:last-child{text-align:right;font-weight:600;}
.map{width:100%;aspect-ratio:16/9;min-height:260px;border:0;border-radius:6px;background:var(--paper-dark);}
.why{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:1rem;margin:1rem 0;}
.why div{background:var(--paper);border-radius:6px;padding:1rem;border-top:3px solid var(--red);}
.why b{display:block;font-family:var(--font-head);letter-spacing:1px;text-transform:uppercase;font-size:.9rem;margin-bottom:.25rem;}
.why span{color:#555;font-size:.93rem;}
.menu-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:.5rem 1.25rem;margin:.5rem 0 1rem;}
.menu-list div{display:flex;justify-content:space-between;gap:.75rem;border-bottom:1px dashed var(--paper-line);padding:.35rem 0;color:#333;}
.menu-list div b{white-space:nowrap;color:var(--ink);}
.others{display:flex;gap:.6rem;flex-wrap:wrap;}
.others a{background:var(--paper);border:1px solid var(--paper-line);padding:.5rem .9rem;border-radius:4px;color:var(--ink)!important;font-family:var(--font-head);letter-spacing:1px;text-transform:uppercase;font-size:.85rem;}
.faq-item{background:var(--paper);border:1px solid var(--paper-line);border-radius:6px;padding:.9rem 1.15rem;margin-bottom:.6rem;}
.faq-item .q{font-family:var(--font-head);font-weight:700;color:var(--ink);letter-spacing:.5px;margin-bottom:.3rem;font-size:.98rem;}
.faq-item .a{color:#444;font-size:.94rem;}
footer{background:var(--black);color:#888;padding:2.5rem 1.5rem;text-align:center;font-family:var(--font-head);font-size:.85rem;letter-spacing:1.5px;line-height:2;}
footer a{color:var(--yellow);text-decoration:none;}"""

FOOTER = """<footer>
<div><img src="/images/wingo-logo-wide.png" alt="Wing-O" width="480" height="253" style="height:56px;width:auto;display:block;margin:0 auto .5rem;"></div>
<div>© Wing-O Restaurants · Regina, Saskatchewan · More Than Wings</div>
<div><a href="/regina-albert-st">Albert Street</a> · <a href="/regina-east">East Regina</a> · <a href="/regina-beach">Regina Beach</a></div>
<div><a href="/">Order Online</a> · <a href="/menu">Menu</a> · <a href="/flavours">Flavours</a> · <a href="/blog.html">Blog</a> · <a href="/faq.html">FAQ</a> · <a href="/catering.html">Catering</a></div>
</footer>"""

MENU_ITEMS = [('Half order of wings', '$7.99'), ('Full order of wings', '$13.99'),
              ('Boneless wings (half / full)', '$7.99 / $13.99'), ('Chicken fingers (half / full)', '$7.99 / $13.99'),
              ('Korean Fried Chicken burger', '$16.49'), ('The Tough Guy (Carolina Reaper chicken)', '$18.99'),
              ('Combo for 1 (wings, fries, pop)', '$17.45'), ('Combo for 4', '$67.99')]


def e(s):
    return html.escape(s, quote=True)


def page(slug, title, desc, h1_html, hero_p, body, ld, crumbs, btns=None, og_type='website'):
    url = f'{SITE}/{slug}'
    lds = '\n'.join(f'<script type="application/ld+json">\n{json.dumps(x, ensure_ascii=False, indent=1)}\n</script>' for x in ld)
    crumb_html = ' › '.join(f'<a href="{h}">{e(t)}</a>' if h else e(t) for t, h in crumbs)
    btn_html = ''
    if btns:
        btn_html = '<div class="btns">' + ''.join(f'<a class="btn{(" " + c) if c else ""}" href="{h}">{t}</a>' for t, h, c in btns) + '</div>'
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{url}">
<link rel="icon" type="image/jpeg" href="/images/logo.jpg">
<meta name="theme-color" content="#0D0D0D">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:image" content="{SITE}/images/logo.jpg">
<meta property="og:url" content="{url}">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="Wing-O Restaurants">
{lds}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@400;500;600;700&family=Playfair+Display:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
{CSS}
</style>
</head>
<body>
<nav><div class="nav-inner"><a href="/" aria-label="Wing-O home"><img src="/images/wingo-logo-wide.png" alt="Wing-O — More Than Wings" width="480" height="253" style="height:40px;width:auto;display:block;"></a><a href="/" class="back">Order Online →</a></div></nav>
<section class="hero"><h1>{h1_html}</h1><p>{hero_p}</p>{btn_html}</section>
<div class="crumbs">{crumb_html}</div>
<div class="container">
{body}
</div>
{FOOTER}
</body>
</html>
"""


def breadcrumb_ld(items):
    return {"@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": f"{SITE}{p}"} for i, (n, p) in enumerate(items)]}


def restaurant_ld(L):
    return {
        "@context": "https://schema.org", "@type": "Restaurant",
        "@id": f"{SITE}/{L['slug']}#restaurant",
        "name": L['name'], "url": f"{SITE}/{L['slug']}",
        "image": f"{SITE}/images/logo.jpg", "logo": f"{SITE}/images/logo.jpg",
        "telephone": '+1-' + L['phone'],
        "priceRange": "$$",
        "servesCuisine": ["Chicken Wings", "Fried Chicken", "Chicken Fingers", "Burgers"],
        "menu": f"{SITE}/menu",
        "hasMenu": f"{SITE}/menu",
        "acceptsReservations": False,
        "address": {"@type": "PostalAddress", "streetAddress": L['street'], "addressLocality": L['city'],
                    "addressRegion": "SK", "addressCountry": "CA"},
        "geo": {"@type": "GeoCoordinates", "latitude": L['lat'], "longitude": L['lng']},
        "hasMap": maps_link(L),
        "openingHoursSpecification": [{"@type": "OpeningHoursSpecification", "dayOfWeek": days, "opens": o, "closes": c}
                                      for days, o, c, _, _ in L['hours']],
        "parentOrganization": {"@type": "Organization", "name": "Wing-O Restaurants", "url": SITE},
    }


def full_addr(L):
    return f"{L['street']}, {L['city']}, SK"


def maps_link(L):
    return 'https://www.google.com/maps/search/?api=1&query=' + urllib.parse.quote(f"Wing-O {full_addr(L)}")


def location_page(L):
    others = [o for o in LOCS if o is not L]
    hours_rows = ''.join(f'<tr><td>{lbl}</td><td>{txt}</td></tr>' for _, _, _, lbl, txt in L['hours'])
    dir_url = 'https://www.google.com/maps/dir/?api=1&destination=' + urllib.parse.quote(full_addr(L))
    embed = 'https://www.google.com/maps?q=' + urllib.parse.quote(f"Wing-O, {full_addr(L)}") + '&output=embed'
    order_line = ('Pickup is ready in about 20 minutes, and we deliver anywhere in Regina for a flat $5.50.'
                  if L['delivery'] else 'Order ahead online and it will be hot and ready when you pull up.')
    menu_rows = ''.join(f'<div><span>{e(n)}</span><b>{p}</b></div>' for n, p in MENU_ITEMS)
    why = ''.join(f'<div><b>{e(t)}</b><span>{e(d)}</span></div>' for t, d in L['why'])
    faqs = [
        (f"Where is Wing-O {L['short']}?", f"Wing-O {L['short']} is at {full_addr(L)}."),
        (f"What are Wing-O {L['short']}'s hours?", ' · '.join(f"{lbl}: {txt}" for _, _, _, lbl, txt in L['hours']) + '.' + (' ' + L['season'] if L.get('season') else '')),
        (f"What is the phone number for Wing-O {L['short']}?", f"Call {L['phone']}."),
        ("Does Wing-O sell fried chicken?", "Yes. Along with bone-in and boneless wings, we serve crispy chicken fingers and hand-breaded fried chicken burgers like the Korean Fried Chicken and The Tough Guy."),
        (f"Can I order online from Wing-O {L['short']}?", "Yes — order online at wingorestaurants.com. " + order_line),
    ]
    faq_html = ''.join(f'<div class="faq-item"><div class="q">{e(q)}</div><div class="a">{e(a)}</div></div>' for q, a in faqs)
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage",
              "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]}
    season = (f'<div class="callout"><div class="label">Seasonal hours</div>{e(L["season"])}</div>' if L.get('season') else '')
    body = f"""<article class="post">
<span class="post-tag">📍 {e(L['short'])}</span>
<h2>Best wings in {e(L['area'])}</h2>
{season}<p>{L['intro']}</p>
<div class="info">
 <div class="box"><div class="label">Address</div><div class="val">{e(L['street'])}<br>{e(L['city'])}, SK</div></div>
 <div class="box"><div class="label">Phone</div><div class="val"><a href="tel:+1{L['phone'].replace('-', '')}">{L['phone']}</a></div></div>
 <div class="box"><div class="label">Hours</div><div class="val"><table class="hours">{hours_rows}</table></div></div>
</div>
<iframe class="map" src="{embed}" title="Map to Wing-O {e(L['short'])}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
<p style="margin-top:1rem;"><a class="btn" href="/">Order Online</a> &nbsp; <a href="{dir_url}" target="_blank" rel="noopener">Get directions →</a></p>
</article>

<article class="post">
<h2>Why Wing-O {e(L['short'])}</h2>
<div class="why">{why}</div>
</article>

<article class="post">
<h2>Chicken wings, boneless &amp; fried chicken</h2>
<p>Every order of <strong>chicken wings</strong> is cooked to order and tossed in your pick of <strong>135+ sauces and dry rubs</strong> — mild Honey Garlic and Maple BBQ, sticky Tangy Thai, all the way up to Devil's Kiss with Carolina Reaper. Prefer no bones? Our <strong>boneless wings</strong> and <strong>crispy chicken fingers</strong> take every flavour too, and our hand-breaded <strong>fried chicken burgers</strong> are a meal on their own.</p>
<div class="menu-list">{menu_rows}</div>
<p>{order_line} <a href="/menu">See the full menu with prices →</a> · <a href="/flavours">All 135+ flavours →</a></p>
</article>

<article class="post">
<h2>Wing-O {e(L['short'])} FAQ</h2>
{faq_html}
</article>

<article class="post">
<h2>Other Wing-O locations</h2>
<div class="others">{''.join(f'<a href="/{o["slug"]}">{e(o["short"])}</a>' for o in others)}</div>
<p style="margin-top:1rem;">Looking for deals? Read <a href="/best-wing-night-deals-regina">the best wing night deals in Regina</a> or <a href="/fried-chicken-regina">where to get fried chicken in Regina</a>.</p>
</article>"""
    ld = [restaurant_ld(L), faq_ld, breadcrumb_ld([('Home', '/'), (L['name'], '/' + L['slug'])])]
    return page(L['slug'], L['title'], L['desc'], e(L['h1']).replace('Chicken Wings', '<span>Chicken Wings</span>', 1),
                f"{e(full_addr(L))} · {' · '.join(lbl + ' ' + txt for _, _, _, lbl, txt in L['hours'])}",
                body, ld, [('Home', '/'), ('Locations', '/#locations'), (L['short'], None)],
                btns=[('Order Online 🍗', '/', ''), (f"Call {L['phone']}", 'tel:+1' + L['phone'].replace('-', ''), 'ghost')])


def article_ld(slug, headline, desc):
    return {"@context": "https://schema.org", "@type": "BlogPosting", "headline": headline, "description": desc,
            "datePublished": UPDATED, "dateModified": UPDATED, "mainEntityOfPage": f"{SITE}/{slug}",
            "image": f"{SITE}/images/logo.jpg",
            "author": {"@type": "Organization", "name": "Wing-O Restaurants", "url": SITE},
            "publisher": {"@type": "Organization", "name": "Wing-O Restaurants", "logo": {"@type": "ImageObject", "url": f"{SITE}/images/logo.jpg"}}}


LOC_BLOCK = """<div class="info">
 <div class="box"><div class="label">Albert Street</div><div class="val">#3 – 155 Albert St N, Regina<br><a href="tel:+16399970553">639-997-0553</a><br>Mon–Wed 11 AM–1 AM · Thu–Sun 11 AM–3 AM<br><a href="/regina-albert-st">Location details →</a></div></div>
 <div class="box"><div class="label">East Regina</div><div class="val">534 University Park Drive, Regina<br><a href="tel:+13065222114">306-522-2114</a><br>Mon–Wed 11 AM–1 AM · Thu–Sun 11 AM–3 AM<br><a href="/regina-east">Location details →</a></div></div>
 <div class="box"><div class="label">Regina Beach</div><div class="val">110 Centre St, Regina Beach<br><a href="tel:+16399970553">639-997-0553</a><br>Summer: every day 11 AM–10 PM (closed for the season)<br><a href="/regina-beach">Location details →</a></div></div>
</div>"""


def deals_post():
    slug = 'best-wing-night-deals-regina'
    title = 'Best Wing Night Deals in Regina — Every Day of the Week | Wing-O'
    headline = 'The Best Wing Night Deals in Regina (Every Day of the Week)'
    desc = "Regina's wing deals, day by day: 89¢ wing Sunday, all-you-can-eat Tuesday, BOGO wing Thursday, the $10 lunch deal and more at Wing-O."
    deals = [
        ('Sunday', '89¢ wings', "89¢ per wing with a minimum of 10. The cheapest way to feed a crowd for the game."),
        ('Monday', 'Boneless BOGO', "Buy an order of boneless wings, get the second 50% off."),
        ('Tuesday', 'All-you-can-eat wings — $28.99', "5 PM to 10 PM, dine-in only. Bring your appetite and work through the flavour vault."),
        ('Wednesday', 'Rib night', "Buy an order of ribs, get the second 50% off."),
        ('Thursday', 'Wing night BOGO', "Buy an order of wings, get the second 50% off — Regina's favourite wing night."),
        ('Friday', '3 orders of wings for $30', "Three full orders, three flavours, one easy Friday."),
        ('Saturday', '2 burgers for $20', "Two burgers — including our crispy fried chicken burgers — for $20."),
    ]
    rows = ''.join(f'<h3>{d} — {e(t)}</h3><p>{e(x)}</p>' for d, t, x in deals)
    faqs = [("What night is wing night in Regina?", "At Wing-O, Thursday is wing night: buy an order of wings and get the second 50% off. Sunday has 89¢ wings (minimum 10) and Tuesday is all-you-can-eat wings for $28.99 (dine-in, 5–10 PM)."),
            ("Where can I get cheap wings in Regina?", "Wing-O's 89¢ wing Sunday (minimum 10) and the $10 lunch deal — wings and small fries, 11 AM to 3:30 PM daily, pickup only — are the best-value wings in Regina."),
            ("Is there all-you-can-eat wings in Regina?", "Yes. Wing-O runs all-you-can-eat wings every Tuesday from 5 PM to 10 PM for $28.99 per person, dine-in only.")]
    faq_html = ''.join(f'<div class="faq-item"><div class="q">{e(q)}</div><div class="a">{e(a)}</div></div>' for q, a in faqs)
    body = f"""<article class="post">
<span class="post-tag">🔥 Deals Guide</span>
<h2>{e(headline)}</h2>
<div class="meta">📅 Updated September 2026 · ⏱️ 4 min read</div>
<p>Wings are better when they're a deal. Here's every weekly <strong>wing night deal in Regina</strong> at Wing-O, so you know exactly which night to go — whether you want <strong>89¢ wings</strong>, <strong>all-you-can-eat wings</strong> or a cheap lunch.</p>
{rows}
<h3>Every day — the $10 lunch deal</h3>
<p>Wings plus small fries, any flavour, for $10. Available 11 AM to 3:30 PM every day, pickup only.</p>
<h3>Late night — 10% off</h3>
<p>Ordering after 11 PM? Online orders placed between 11 PM and close get 10% off automatically at checkout.</p>
<div class="callout"><div class="label">New here?</div>Your first online order gets <strong>15% off automatically</strong> on orders of $25 or more — no code needed.</div>
<p>Deals can vary by location, so give your nearest Wing-O a call if you want to double-check before you head over.</p>
<a class="btn" href="/">Order Online</a>
</article>
<article class="post">
<h2>Where to find us</h2>
{LOC_BLOCK}
</article>
<article class="post">
<h2>Wing deal FAQ</h2>
{faq_html}
</article>"""
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage",
              "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]}
    ld = [article_ld(slug, headline, desc), faq_ld,
          breadcrumb_ld([('Home', '/'), ('Blog', '/blog.html'), (headline, '/' + slug)])]
    return slug, page(slug, title, desc, 'Wing Night <span>Deals</span> in Regina',
                      'Seven days, seven deals — plus the $10 lunch.', body, ld,
                      [('Home', '/'), ('Blog', '/blog.html'), ('Wing Night Deals', None)], og_type='article')


def fried_chicken_post():
    slug = 'fried-chicken-regina'
    title = 'Where to Get Fried Chicken in Regina | Wing-O'
    headline = 'Where to Get Fried Chicken in Regina'
    desc = "Craving fried chicken in Regina? Crispy bone-in wings, boneless wings, chicken fingers and hand-breaded fried chicken burgers at Wing-O — open till 3am Thu–Sun."
    body = f"""<article class="post">
<span class="post-tag">🍗 Regina Food Guide</span>
<h2>{e(headline)}</h2>
<div class="meta">📅 Updated September 2026 · ⏱️ 4 min read</div>
<p>When a <strong>fried chicken</strong> craving hits in Regina, you want it crispy, hot and fast. At Wing-O, everything chicken is fried to order and finished with your choice of <strong>135+ sauces and dry rubs</strong>. Here's how to get your fix.</p>
<h3>Crispy bone-in chicken wings</h3>
<p>Our signature. Fried until the skin crackles, then tossed in anything from Honey Garlic to Devil's Kiss (Carolina Reaper). A half order is $7.99 and a full order is $13.99.</p>
<h3>Boneless wings</h3>
<p>All the crunch, none of the bones — and every flavour works. Half $7.99, full $13.99.</p>
<h3>Chicken fingers</h3>
<p>Crispy, juicy chicken fingers with your choice of dipping sauce. Half $7.99, full $13.99 — a favourite with kids and anyone who likes to dunk.</p>
<h3>Fried chicken burgers</h3>
<p>Hand-breaded chicken breast on a toasted bun, served with fries and a drink:</p>
<ul class="bullet">
<li><strong>Korean Fried Chicken (KFC)</strong> — scratch-made Korean BBQ sauce, coleslaw and pickles. $16.49</li>
<li><strong>The Tough Guy</strong> — double-crunched and coated in blazing Carolina Reaper sauce. $18.99</li>
<li><strong>The Dillinator</strong> — honey dill sauce and pickle chips. $18.99</li>
<li><strong>The Buffalo Stampede</strong> — house-made buffalo sauce and creamy coleslaw. $18.99</li>
<li><strong>The Sunset Crunch</strong> — sweet heat habanero mango and California ranch. $15.99</li>
</ul>
<h3>Late-night fried chicken in Regina</h3>
<p>Our Regina locations stay open until <strong>1 AM Monday to Wednesday</strong> and <strong>3 AM Thursday to Sunday</strong> — so fried chicken after the bar or a late shift is covered. Order online for pickup, or get delivery anywhere in Regina for a flat $5.50.</p>
<div class="callout"><div class="label">Feeding a group?</div>Our combos (from $17.45 for one to $67.99 for four) and <a href="/catering.html">catering packages</a> mix wings, fingers and sides.</div>
<a class="btn" href="/">Order Fried Chicken Online</a>
</article>
<article class="post">
<h2>Where to find us</h2>
{LOC_BLOCK}
<p>Want the cheapest night to go? See <a href="/best-wing-night-deals-regina">Regina's best wing night deals</a>.</p>
</article>"""
    ld = [article_ld(slug, headline, desc),
          breadcrumb_ld([('Home', '/'), ('Blog', '/blog.html'), (headline, '/' + slug)])]
    return slug, page(slug, title, desc, '<span>Fried Chicken</span> in Regina',
                      'Wings, boneless, fingers and fried chicken burgers — fried to order.', body, ld,
                      [('Home', '/'), ('Blog', '/blog.html'), ('Fried Chicken in Regina', None)], og_type='article')


def site_data():
    """MENU, FLAVORS and FLAVOR_HEAT straight from the ordering page, so these pages never drift from it."""
    js = r"""
const fs = require('fs'); const src = fs.readFileSync(process.argv[1], 'utf8');
function grab(name) { const i = src.indexOf('var ' + name + ' = '); if (i < 0) throw new Error('missing ' + name);
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return eval('(' + src.slice(j, k + 1) + ')'); }
process.stdout.write(JSON.stringify({ MENU: grab('MENU'), FLAVORS: grab('FLAVORS'), HEAT: grab('FLAVOR_HEAT') }));
"""
    out = subprocess.run(['node', '-e', js, os.path.join(OUT, 'index.html')], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


DATA = site_data()
MENU_SECTIONS = [('wings', 'Chicken Wings (bone-in)'), ('boneless', 'Boneless Wings'), ('chickenfingers', 'Chicken Fingers'), ('ribs', 'Ribs'),
                 ('burgers', 'Fried Chicken Burgers'), ('combos', 'Combos'), ('platters', 'Platters'), ('sides', 'Sides & Starters'),
                 ('loaded', 'Poutine & Loaded Fries'), ('salads', 'Salads'), ('midnight', 'Desserts'), ('drinks', 'Refreshers & Lemonades')]
HEAT_WORD = {'🍯': 'Sweet', '🫑': 'Mild', '😐': 'Savoury', '🌶️': 'Medium', '🔥': 'Hot'}
FLAVOUR_BLURB = {
    'Flirty Ones': 'The classics everyone starts with.', 'Second Round': 'House mash-ups of two or three sauces.',
    'Rub It': 'Dry rubs: all the flavour, none of the mess.', 'Have To Do It': 'Creamy, cheesy and garlicky.',
    'Sweet Melodious': 'Sweet and fruity glazes.', 'Illegal Sauces': 'Our secret combos. Only at Wing-O.',
    'BBQ Intimacy': 'Smoky, sticky BBQ every way.', 'Hot As Hell': 'From Mild to Dead Angel (Carolina Reaper).'}


def money(x):
    return f'${x:,.2f}'


def item_price(it):
    if it.get('sizes3'):
        labels = it.get('sizeLabels3') or ['Small', 'Medium', 'Large']
        return ' / '.join(f'{l} {money(p)}' for l, p in zip(labels, [it['price'], it['price2'], it['price3']]))
    if it.get('sizes'):
        labels = it.get('sizeLabels') or ['Small', 'Large']
        return ' / '.join(f'{l} {money(p)}' for l, p in zip(labels, [it['price'], it['price2']]))
    return money(it['price'])


def split_flavour(f):
    m = re.match(r'^(.*?)\s*\((.*)\)$', f)
    return (m.group(1), m.group(2)) if m else (f, '')


def flavour_count():
    return sum(len(v) for v in DATA['FLAVORS'].values())


MENU_CSS_EXTRA = """
.mi{display:flex;justify-content:space-between;gap:1rem;border-bottom:1px dashed var(--paper-line);padding:.6rem 0;}
.mi:last-child{border-bottom:0;}
.mi b{display:block;color:var(--ink);font-size:1.02rem;}
.mi span{display:block;color:#555;font-size:.92rem;line-height:1.5;}
.mi .pr{font-weight:700;color:var(--red);text-align:right;flex:none;max-width:45%;}
.mi .pr span{display:block;color:var(--red);font-size:.92rem;white-space:nowrap;}
.toc{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.5rem;}
.toc a{background:var(--paper);border:1px solid var(--paper-line);padding:.35rem .7rem;border-radius:4px;font-family:var(--font-head);font-size:.8rem;letter-spacing:1px;text-transform:uppercase;color:var(--ink)!important;}
.fl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:.1rem 1.25rem;}
.fl div{border-bottom:1px dashed var(--paper-line);padding:.45rem 0;}
.fl b{color:var(--ink);}
.fl i{font-style:normal;font-size:.75rem;font-family:var(--font-head);letter-spacing:1px;text-transform:uppercase;color:#fff;border-radius:3px;padding:.05rem .4rem;margin-left:.35rem;vertical-align:middle;}
.fl small{display:block;color:#666;font-size:.86rem;}
.h-Sweet{background:#d6457a;}.h-Mild{background:#4a9b3a;}.h-Savoury{background:#3b82b5;}.h-Medium{background:#d98a00;}.h-Hot{background:var(--red);}
"""


def page_x(*a, **k):
    return page(*a, **k).replace('</style>', MENU_CSS_EXTRA + '</style>', 1)


def menu_page():
    slug = 'menu'
    title = 'Wing-O Menu & Prices: Wings, Boneless, Burgers, Poutine | Regina'
    desc = 'Full Wing-O menu with prices: bone-in and boneless chicken wings from $7.99, fried chicken burgers, combos, platters, poutine and sides. 135+ flavours. Regina, SK.'
    secs, ld_secs = '', []
    for key, label in MENU_SECTIONS:
        items = DATA['MENU'].get(key) or []
        if not items:
            continue
        rows = ''.join(f'<div class="mi"><div><b>{e(it["name"])}</b><span>{e(it.get("desc", ""))}</span></div><div class="pr">{"".join(f"<span>{e(x)}</span>" for x in item_price(it).split(" / "))}</div></div>' for it in items)
        secs += f'<article class="post" id="{key}"><h2>{e(label)}</h2>{rows}</article>'
        ld_secs.append({"@type": "MenuSection", "name": label, "hasMenuItem": [
            {"@type": "MenuItem", "name": it['name'], "description": it.get('desc', ''),
             "offers": {"@type": "Offer", "price": f'{it["price"]:.2f}', "priceCurrency": "CAD"}} for it in items]})
    toc = ''.join(f'<a href="#{k}">{e(l)}</a>' for k, l in MENU_SECTIONS if DATA['MENU'].get(k))
    body = f"""<article class="post">
<span class="post-tag">🍗 Full Menu</span>
<h2>Wing-O menu with prices</h2>
<p>Every wing order is tossed in your choice of <strong>135+ sauces and dry rubs</strong> (<a href="/flavours">see every flavour</a>). Prices are the same at our Regina locations and are in Canadian dollars, before GST and PST. Order online for pickup or delivery in Regina ($5.50 flat).</p>
<div class="toc">{toc}</div>
<p style="margin-top:1rem;"><a class="btn" href="/">Order Online</a> &nbsp; <a href="/best-wing-night-deals-regina">This week's deals →</a></p>
</article>
{secs}
<article class="post"><h2>Where to order</h2>{LOC_BLOCK}</article>"""
    ld = [{"@context": "https://schema.org", "@type": "Menu", "@id": f"{SITE}/menu", "name": "Wing-O Menu", "url": f"{SITE}/menu",
           "inLanguage": "en-CA", "hasMenuSection": ld_secs},
          breadcrumb_ld([('Home', '/'), ('Menu', '/menu')])]
    return slug, page_x(slug, title, desc, 'The Wing-O <span>Menu</span>', 'Wings, boneless, burgers, poutine and more, with prices.',
                        body, ld, [('Home', '/'), ('Menu', None)], btns=[('Order Online 🍗', '/', ''), ('See All Flavours', '/flavours', 'ghost')])


def flavours_page():
    slug = 'flavours'
    n = flavour_count()
    title = f'All Wing-O Wing Flavours: {n} Sauces & Dry Rubs | Regina Wings'
    desc = (f"Every Wing-O wing flavour: {n} sauces and dry rubs from Honey Garlic and Honey Dill to Dead Angel (Carolina Reaper), "
            "plus house combos like Illegal Sauces. Heat level for each.")
    secs, all_names = '', []
    for group, flavours in DATA['FLAVORS'].items():
        cells = ''
        for f in flavours:
            name, combo = split_flavour(f)
            heat = HEAT_WORD.get(DATA['HEAT'].get(f, ''), '')
            all_names.append(name)
            tag = f'<i class="h-{heat}">{heat}</i>' if heat else ''
            sub = f'<small>{e(combo)}</small>' if combo else ''
            cells += f'<div><b>{e(name)}</b>{tag}{sub}</div>'
        secs += f'<article class="post" id="{re.sub("[^a-z]+", "-", group.lower()).strip("-")}"><h2>{e(group)}</h2><p>{e(FLAVOUR_BLURB.get(group, ""))} ({len(flavours)} flavours)</p><div class="fl">{cells}</div></article>'
    faqs = [("How many wing flavours does Wing-O have?", f"Wing-O's menu lists {n} wing sauces and dry rubs in 8 groups, from mild classics like Honey Garlic to Dead Angel (Carolina Reaper)."),
            ("What is the hottest wing at Wing-O?", "Dead Angel, made with Carolina Reaper, is our hottest sauce. Spicy Mammilla (Caesar + Dead Angel + Ranch) and Devil's Kiss are also very hot."),
            ("What are the most popular Wing-O flavours?", "Honey Garlic, Honey Dill, Buffalo, Salt & Pepper and Lemon Pepper are guest favourites. Ask for the flavour of the week in store."),
            ("Does Wing-O have dry rub wings?", "Yes. The Rub It group has 25+ dry rubs, including Salt & Vinegar, Dill Pickle, Lemon Pepper, Cajun and Montreal Style."),
            ("Can I get two flavours in one order?", "Each order gets one flavour. With two or more orders you can pick a different flavour for each, and our combo sauces (Second Round and Illegal Sauces) mix two or three sauces for you.")]
    faq_html = ''.join(f'<div class="faq-item"><div class="q">{e(q)}</div><div class="a">{e(a)}</div></div>' for q, a in faqs)
    toc = ''.join(f'<a href="#{re.sub("[^a-z]+", "-", g.lower()).strip("-")}">{e(g)}</a>' for g in DATA['FLAVORS'])
    body = f"""<article class="post">
<span class="post-tag">🔥 Flavour Vault</span>
<h2>Every Wing-O wing flavour</h2>
<p>Pick any flavour for <strong>bone-in wings, boneless wings, ribs, chicken fingers or cauliflower wings</strong>. Sauces are made from scratch by our Sauce Boss. Heat levels: <b>Sweet</b>, <b>Mild</b>, <b>Savoury</b>, <b>Medium</b> and <b>Hot</b>.</p>
<div class="toc">{toc}</div>
<p style="margin-top:1rem;"><a class="btn" href="/">Order Online</a> &nbsp; <a href="/menu">Menu &amp; prices →</a></p>
</article>
{secs}
<article class="post"><h2>Flavour FAQ</h2>{faq_html}</article>"""
    ld = [{"@context": "https://schema.org", "@type": "ItemList", "name": "Wing-O wing flavours", "numberOfItems": n,
           "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": x} for i, x in enumerate(all_names)]},
          {"@context": "https://schema.org", "@type": "FAQPage",
           "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]},
          breadcrumb_ld([('Home', '/'), ('Flavours', '/flavours')])]
    return slug, page_x(slug, title, desc, 'Every <span>Flavour</span>', f'{n} sauces &amp; dry rubs, from Honey Garlic to Carolina Reaper.',
                        body, ld, [('Home', '/'), ('Flavours', None)], btns=[('Order Online 🍗', '/', ''), ('Menu & Prices', '/menu', 'ghost')])


def guide(slug, title, desc, headline, h1, hero, tag, sections, faqs, crumb):
    rows = ''.join(f'<h3>{e(h)}</h3><p>{p}</p>' for h, p in sections)
    faq_html = ''.join(f'<div class="faq-item"><div class="q">{e(q)}</div><div class="a">{e(a)}</div></div>' for q, a in faqs)
    body = f"""<article class="post">
<span class="post-tag">{tag}</span>
<h2>{e(headline)}</h2>
<div class="meta">📅 Updated October 2026</div>
{rows}
<a class="btn" href="/">Order Online</a>
</article>
<article class="post"><h2>Where to find us</h2>{LOC_BLOCK}</article>
<article class="post"><h2>FAQ</h2>{faq_html}</article>"""
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage",
              "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]}
    ld = [article_ld(slug, headline, desc), faq_ld, breadcrumb_ld([('Home', '/'), ('Blog', '/blog.html'), (headline, '/' + slug)])]
    return slug, page(slug, title, desc, h1, hero, body, ld, [('Home', '/'), ('Blog', '/blog.html'), (crumb, None)], og_type='article')


def best_wings_post():
    n = flavour_count()
    return guide('best-wings-regina', 'Best Chicken Wings in Regina: Flavours, Prices & Late Hours | Wing-O',
        f'Looking for the best wings in Regina? Wing-O has 135+ flavours, crispy bone-in and boneless wings from $7.99, daily deals and hours until 3 AM Thu–Sun.',
        'Where to Get the Best Chicken Wings in Regina', 'Best <span>Wings</span> in Regina', 'Crispy, sauced to order, and open late.', '🏆 Regina Food Guide',
        [('Why Wing-O', f'Wing-O started on Albert Street in Regina and is known for one of the <strong>biggest wing flavour lists in the city</strong>: 135+ flavours, with {n} sauces and dry rubs on the current menu. Every order is fried to order and tossed in sauce made from scratch.'),
         ('The wings', 'Crispy <strong>bone-in wings</strong> and <strong>boneless wings</strong>, half order $7.99, full order $13.99. Two to five orders let you pick a different flavour for each. Ribs, chicken fingers and cauliflower wings take every flavour too.'),
         ('The flavours', 'Start with the classics (Honey Garlic, Honey Dill, Buffalo, Salt &amp; Pepper), try a house combo from the <strong>Illegal Sauces</strong>, or go all the way to <strong>Dead Angel</strong>, made with Carolina Reaper. <a href="/flavours">See every flavour →</a>'),
         ('The deals', '89¢ wings on Sunday, all-you-can-eat wings on Tuesday ($28.99, dine-in), and buy-one-get-one-50%-off wings on Thursday. <a href="/best-wing-night-deals-regina">All daily deals →</a>'),
         ('Open late', 'Our Regina locations are open until <strong>1 AM Monday to Wednesday</strong> and <strong>3 AM Thursday to Sunday</strong>, with pickup and delivery across Regina.')],
        [('What are the best wings in Regina?', 'Wing-O is a Regina favourite for wings: 135+ flavours, crispy bone-in and boneless wings from $7.99, and two Regina locations open until 3 AM Thursday to Sunday.'),
         ('Where are Wing-O locations in Regina?', 'Wing-O is at #3 – 155 Albert St N and 534 University Park Drive in Regina, plus a summer location at 110 Centre St in Regina Beach.'),
         ('How much are wings at Wing-O?', 'A half order is $7.99 and a full order is $13.99, for bone-in or boneless. Sunday wings are 89¢ each (minimum 10).'),
         ('Does Wing-O deliver in Regina?', 'Yes. Order at wingorestaurants.com for delivery anywhere in Regina for a flat $5.50, or pickup in about 20 minutes.')],
        'Best Wings in Regina')


def late_night_post():
    return guide('late-night-food-regina', 'Late Night Food in Regina: Wings Open Until 3 AM | Wing-O',
        'Hungry after midnight in Regina? Wing-O is open until 1 AM Mon–Wed and 3 AM Thu–Sun for wings, burgers and poutine, with 10% off online orders after 11 PM.',
        'Late Night Food in Regina: Where to Eat After Midnight', 'Late Night <span>Food</span> in Regina', 'Wings until 3 AM, Thursday to Sunday.', '🌙 Late Night Guide',
        [('Open late, every night', 'Wing-O Albert Street and Wing-O East Regina are open until <strong>1 AM Monday to Wednesday</strong> and until <strong>3 AM Thursday to Sunday</strong>.'),
         ('What to order after midnight', 'Crispy wings in any of our 135+ flavours, fried chicken burgers, loaded poutine, mozza sticks and deep-fried desserts like deep-fried Oreos and Mars bars. <a href="/menu">Full menu →</a>'),
         ('10% off late-night orders', 'Online orders placed after 11 PM get <strong>10% off automatically</strong> at checkout.'),
         ('Pickup or delivery', 'Order at wingorestaurants.com for pickup in about 20 minutes, or delivery anywhere in Regina for a flat $5.50.')],
        [('What food is open late in Regina?', 'Wing-O is open until 1 AM Monday to Wednesday and 3 AM Thursday to Sunday at 155 Albert St N and 534 University Park Drive, serving wings, burgers and poutine.'),
         ('Is there late-night delivery in Regina?', 'Yes. Wing-O delivers anywhere in Regina until close for a flat $5.50, and online orders after 11 PM get 10% off.'),
         ('Where can I get wings at 2 AM in Regina?', 'Wing-O Albert Street and Wing-O East Regina are open until 3 AM Thursday to Sunday.')],
        'Late Night Food in Regina')


def llms_txt():
    groups = '\n'.join(f'- {g}: ' + ', '.join(split_flavour(f)[0] for f in fl) for g, fl in DATA['FLAVORS'].items())
    return f"""# Wing-O Restaurants

> Wing-O is a chicken wing restaurant from Regina, Saskatchewan, Canada, known for 135+ wing flavours (sauces and dry rubs made from scratch), crispy bone-in and boneless wings, fried chicken burgers, poutine and late-night hours. Tagline: "More Than Wings". Online ordering for pickup and delivery at https://wingorestaurants.com.

## Locations
- Wing-O Albert Street: #3 - 155 Albert St N, Regina, SK. Phone 639-997-0553. Mon-Wed 11 AM-1 AM, Thu-Sun 11 AM-3 AM. Pickup and delivery. https://wingorestaurants.com/regina-albert-st
- Wing-O East Regina: 534 University Park Drive, Regina, SK. Phone 306-522-2114. Mon-Wed 11 AM-1 AM, Thu-Sun 11 AM-3 AM. Pickup and delivery. https://wingorestaurants.com/regina-east
- Wing-O Regina Beach: 110 Centre St, Regina Beach, SK. Summer location (every day 11 AM-10 PM in season), currently closed for the season. https://wingorestaurants.com/regina-beach
- Wing-O Winnipeg: 1530 Dakota St, Unit 4001, Winnipeg, MB. Opening soon. https://wingorestaurants.com/winnipeg

## Menu and prices (CAD)
- Bone-in or boneless wings: half order $7.99, full order $13.99. Ribs and chicken fingers the same.
- Fried chicken burgers $15.99-$18.99 (The Tough Guy with Carolina Reaper, The Dillinator, The Buffalo Stampede, Korean Fried Chicken, The Sunset Crunch), served with fries and a drink.
- Combos from $17.45 (for 1) to $67.99 (for 4). Platters $29.99-$56.99. Poutine from $8.99.
- Delivery anywhere in Regina: $5.50 flat. First online order: 15% off orders of $25+. Online orders after 11 PM: 10% off.
- Full menu: https://wingorestaurants.com/menu

## Weekly deals
- Sunday: 89 cent wings (minimum 10)
- Monday: boneless wings, second order 50% off
- Tuesday: all-you-can-eat wings $28.99, 5-10 PM, dine-in
- Wednesday: ribs, second order 50% off
- Thursday: wing night, second order of wings 50% off
- Friday: 3 orders of wings for $30
- Saturday: 2 burgers for $20
- Every day: $10 lunch (wings + small fries), 11 AM-3:30 PM, pickup
- Details: https://wingorestaurants.com/best-wing-night-deals-regina

## Flavours ({flavour_count()} sauces and dry rubs; hottest is Dead Angel, Carolina Reaper)
{groups}
- Every flavour with heat levels: https://wingorestaurants.com/flavours

## Loyalty
- Saucy Stamps: free loyalty card. 10 orders = a free half order of wings. Sign up at https://wingorestaurants.com

## More
- Best wings in Regina: https://wingorestaurants.com/best-wings-regina
- Late night food in Regina: https://wingorestaurants.com/late-night-food-regina
- Fried chicken in Regina: https://wingorestaurants.com/fried-chicken-regina
- Catering: https://wingorestaurants.com/catering.html
- FAQ: https://wingorestaurants.com/faq.html
- Careers: https://wingorestaurants.com/careers.html
- Franchising: https://wingorestaurants.com/#franchise
- Contact: besaucy@wingorestaurants.com
"""


SITEMAP_PAGES = [('/', 'daily', '1.0'), ('/menu', 'weekly', '0.9'), ('/flavours', 'weekly', '0.9'),
                 ('/regina-albert-st', 'monthly', '0.8'), ('/regina-east', 'monthly', '0.8'), ('/regina-beach', 'monthly', '0.7'),
                 ('/winnipeg', 'weekly', '0.8'), ('/best-wings-regina', 'monthly', '0.7'), ('/best-wing-night-deals-regina', 'weekly', '0.7'),
                 ('/late-night-food-regina', 'monthly', '0.7'), ('/fried-chicken-regina', 'monthly', '0.6'), ('/catering.html', 'monthly', '0.6'),
                 ('/careers.html', 'monthly', '0.5'), ('/blog.html', 'weekly', '0.5'), ('/faq.html', 'monthly', '0.5')]


def sitemap():
    urls = ''.join(f'  <url>\n    <loc>{SITE}{p}</loc>\n    <lastmod>{UPDATED}</lastmod>\n    <changefreq>{c}</changefreq>\n    <priority>{pr}</priority>\n  </url>\n'
                   for p, c, pr in SITEMAP_PAGES)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n'


if __name__ == '__main__':
    for L in LOCS:
        open(os.path.join(OUT, L['slug'] + '.html'), 'w').write(location_page(L))
        print('wrote', L['slug'])
    for fn in (deals_post, fried_chicken_post, menu_page, flavours_page, best_wings_post, late_night_post):
        slug, h = fn()
        open(os.path.join(OUT, slug + '.html'), 'w').write(h)
        print('wrote', slug)
    open(os.path.join(OUT, 'llms.txt'), 'w').write(llms_txt())
    open(os.path.join(OUT, 'sitemap.xml'), 'w').write(sitemap())
    print('wrote llms.txt, sitemap.xml')
