// api/ghl-to-squeegee.js
// Deploy on Vercel — receives GHL webhook, creates customer/jobs/quotes in Squeegee

const SQUEEGEE_BASE = 'https://kingswindowcleaning.sqgee.com';
const SQUEEGEE_TOKEN = process.env.SQUEEGEE_TOKEN || 'PARTNER-8f51e35c-a366-4cc6-9f73-d26152ca81a6';

// ─── Service Map ──────────────────────────────────────────────────────────────
const SERVICE_MAP = [
  {
    key: 'internal_window',
    id: 'c3351696-c2f2-4622-b3da-774e66856a7e',
    field: 'ad_hoc_internal_window_cleaning',
    keywords: ['internal window', 'inside window'],
  },
  {
    key: 'conservatory_internal',
    id: '37a56b86-8b23-490d-b490-9205112cda9b',
    field: 'con_roof',
    keywords: ['conservatory clean internal', 'conservatory internal', 'con roof'],
  },
  {
    key: 'conservatory_external',
    id: '888ff0a5-e810-4918-b635-018286e7614e',
    field: 'conservatory_roof_cleaning',
    keywords: ['conservatory clean external', 'conservatory external', 'conservatory roof'],
  },
  {
    key: 'gutter',
    id: '0408a226-cd3d-4cad-b4e2-32cb5e6f5a67',
    field: 'full_gutter_clearance',
    keywords: ['gutter clearance', 'full gutter', 'gutter clean', 'gutter'],
  },
  {
    key: 'fascia',
    id: 'd2880172-cd7e-4209-9616-7af3b91ce2c4',
    field: 'fascia_soffit_and_gutter_clean',
    keywords: ['fascia', 'soffit'],
  },
];

const EXTERNAL_WINDOW_ID = '8e49f084-bcbb-4ee9-86b1-da4649cf5329';
const EXTERNAL_WINDOW_KEYWORDS = ['external window', 'window clean', 'outside window'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(raw) {
  if (!raw) return new Date().toISOString().split('T')[0];
  const cleaned = raw
    .replace(/(\d+)(st|nd|rd|th)/gi, '$1')
    .replace(/,?\s*(AM|PM)\s*$/i, '')
    .trim();
  const parsed = new Date(cleaned);
  if (isNaN(parsed.getTime())) return new Date().toISOString().split('T')[0];
  return parsed.toISOString().split('T')[0];
}

function parsePrice(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = parseFloat(String(val).replace(/[£$,\s]/g, ''));
  return isNaN(num) ? null : num;
}

function matchesKeywords(name, keywords) {
  const lower = name.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function extractInterval(name) {
  const match = name.match(/\b(6|8|12)\b/);
  return match ? parseInt(match[1]) : null;
}

function parseBookedServices(text) {
  if (!text) return [];
  const results = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^(.+?)\s*[-–]\s*£?([\d,]+(?:\.\d{1,2})?)\s*$/);
    if (match) {
      results.push({ name: match[1].trim(), price: parseFloat(match[2].replace(',', '')) });
    }
  }
  return results;
}

function buildJob(serviceId, date, price, frequencyInterval) {
  const payload = {
    date,
    services: [serviceId],
    price,
    notes: 'Booked job',
    tags: ['booked'],
    frequencyType: frequencyInterval ? 'weeks' : 'adhoc',
    firstAppointment: {
      tags: ['first-visit'],
      initialDate: date,
    },
  };
  if (frequencyInterval) payload.frequencyInterval = frequencyInterval;
  return payload;
}

function buildQuote(serviceId, price, frequencyInterval, date) {
  const payload = {
    services: [serviceId],
    tags: ['quote'],
    price,
    notes: 'Quote',
    frequencyType: frequencyInterval ? 'weeks' : 'adhoc',
    firstAppointment: {
      tags: ['first-visit'],
      initialDate: date,
    },
  };
  if (frequencyInterval) payload.frequencyInterval = frequencyInterval;
  return payload;
}

// ─── Squeegee API caller ──────────────────────────────────────────────────────

async function squeegeePost(path, body) {
  const url = `${SQUEEGEE_BASE}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SQUEEGEE_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const json = await response.json();

  if (!response.ok || json.success === false) {
    throw new Error(`Squeegee POST ${path} failed [${response.status}]: ${JSON.stringify(json)}`);
  }

  return json;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const c = req.body;
    const log = [];

    // ── 1. Create Customer ───────────────────────────────────────────────────
    const customerPayload = {
      name: c.name,
      email: c.email,
      phone: c.phone,
      address: { text: c.address__postal_code },
      reference: c.id,
    };

    const customerRes = await squeegeePost('/api/v3/partner/customers', customerPayload);
    const customerId = customerRes.data; // UUID from Squeegee response
    log.push({ type: 'customer', id: customerId });

    // ── Parse shared data ────────────────────────────────────────────────────
    const date = parseDate(c.appointment_time_requested);
    const bookedServices = parseBookedServices(c.booked_services_array);

    // ── 2. External Window Cleaning ──────────────────────────────────────────
    const externalFrequencies = [
      { interval: 6,    price: parsePrice(c['6weekly']) },
      { interval: 8,    price: parsePrice(c['8weekly']) },
      { interval: 12,   price: parsePrice(c['12weekly']) },
      { interval: null, price: parsePrice(c.oneoff) },
    ];

    const bookedExternal = bookedServices.find((s) =>
      matchesKeywords(s.name, EXTERNAL_WINDOW_KEYWORDS)
    );
    const bookedExternalInterval = bookedExternal ? extractInterval(bookedExternal.name) : undefined;

    for (const freq of externalFrequencies) {
      if (freq.price === null) continue;

      const isBooked = bookedExternal !== undefined && freq.interval === bookedExternalInterval;

      if (isBooked) {
        const jobRes = await squeegeePost(
          `/api/v3/partner/customers/${customerId}/jobs`,
          buildJob(EXTERNAL_WINDOW_ID, date, freq.price, freq.interval)
        );
        log.push({ type: 'job', service: 'external_window', interval: freq.interval, id: jobRes.data });
      } else {
        const quoteRes = await squeegeePost(
          `/api/v3/partner/customers/${customerId}/quote`,
          buildQuote(EXTERNAL_WINDOW_ID, freq.price, freq.interval, date)
        );
        log.push({ type: 'quote', service: 'external_window', interval: freq.interval, id: quoteRes.data });
      }
    }

    // ── 3. Other 5 Services ──────────────────────────────────────────────────
    for (const service of SERVICE_MAP) {
      const price = parsePrice(c[service.field]);
      if (price === null) continue;

      const isBooked = bookedServices.some((s) => matchesKeywords(s.name, service.keywords));

      if (isBooked) {
        const jobRes = await squeegeePost(
          `/api/v3/partner/customers/${customerId}/jobs`,
          buildJob(service.id, date, price, null)
        );
        log.push({ type: 'job', service: service.key, id: jobRes.data });
      } else {
        const quoteRes = await squeegeePost(
          `/api/v3/partner/customers/${customerId}/quote`,
          buildQuote(service.id, price, null, date)
        );
        log.push({ type: 'quote', service: service.key, id: quoteRes.data });
      }
    }

    return res.status(200).json({ success: true, customerId, created: log });
  } catch (err) {
    console.error('[ghl-to-squeegee]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}


