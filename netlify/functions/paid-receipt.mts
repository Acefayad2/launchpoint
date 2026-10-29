import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const STRIPE_API = 'https://api.stripe.com/v1';
const AMG_REFERENCE = 'LP-AMG-20261027-01';

function message(text: string, status: number) {
  return new Response(JSON.stringify({ error: text }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function printable(value: unknown, limit: number) {
  return String(value || '').replace(/[^\x20-\x7E]/g, '-').replace(/\s+/g, ' ').slice(0, limit).trim();
}

function dollars(cents: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function paymentMethod(details: Record<string, any> | undefined) {
  const wallet = details?.card?.wallet?.type;
  if (wallet === 'apple_pay') return 'Apple Pay';
  if (wallet === 'google_pay') return 'Google Pay';
  if (details?.type === 'card') return 'Card';
  return printable(details?.type || 'Secure payment', 32).replace(/_/g, ' ');
}

function receiptData(intent: Record<string, any>) {
  const dynamic = intent.metadata?.launchpoint_invoice === '1';
  const amg = intent.metadata?.invoice_id === AMG_REFERENCE && intent.amount === 450_000;
  if (!dynamic && !amg) return null;
  if (intent.status !== 'succeeded' || intent.amount_received !== intent.amount || intent.currency !== 'usd') return null;
  const company = dynamic ? printable(intent.metadata.company, 100) : 'Anointed Money Group (AMG)';
  const service = dynamic ? printable(intent.metadata.service_description, 120) : 'Website, domain, SMS administration and Supabase setup';
  const reference = dynamic ? printable(intent.metadata.reference, 80) : AMG_REFERENCE;
  if (!company || !service || !reference) return null;
  const paidAt = Number(intent.latest_charge?.created || intent.created);
  return {
    company, service, reference, amount: dollars(intent.amount),
    paidAt: new Date(paidAt * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }),
    method: paymentMethod(intent.latest_charge?.payment_method_details),
    paymentId: printable(intent.id, 80),
    test: intent.livemode === false
  };
}

async function makePdf(data: NonNullable<ReturnType<typeof receiptData>>) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(.13, .15, .16);
  const muted = rgb(.42, .44, .45);
  const orange = rgb(.69, .27, .06);
  const line = rgb(.86, .86, .83);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(.965, .959, .945) });
  page.drawRectangle({ x: 36, y: 42, width: 540, height: 708, color: rgb(1, 1, 1) });
  page.drawText('Launch', { x: 64, y: 708, font: bold, size: 22, color: ink });
  page.drawText('Point', { x: 137, y: 708, font: bold, size: 22, color: orange });
  page.drawText(data.test ? 'TEST PAYMENT RECEIPT' : 'PAYMENT RECEIPT', { x: 378, y: 713, font: bold, size: 9, color: muted });
  page.drawLine({ start: { x: 64, y: 686 }, end: { x: 548, y: 686 }, thickness: 1, color: line });
  page.drawText('Invoice paid', { x: 64, y: 631, font: bold, size: 33, color: ink });
  page.drawText('PAID', { x: 490, y: 640, font: bold, size: 11, color: rgb(.17, .42, .28) });
  page.drawText('Payment received', { x: 64, y: 604, font: regular, size: 12, color: muted });
  page.drawText(data.amount, { x: 64, y: 543, font: bold, size: 37, color: ink });
  page.drawText('USD', { x: 64, y: 521, font: bold, size: 9, color: muted });
  page.drawLine({ start: { x: 64, y: 495 }, end: { x: 548, y: 495 }, thickness: 1, color: line });

  const field = (label: string, value: string, y: number, maxWidth = 450) => {
    page.drawText(label.toUpperCase(), { x: 64, y, font: bold, size: 9, color: muted });
    const size = 12;
    const words = value.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (regular.widthOfTextAtSize(next, size) > maxWidth && current) { lines.push(current); current = word; }
      else current = next;
    }
    if (current) lines.push(current);
    lines.slice(0, 2).forEach((text, index) => page.drawText(text, { x: 64, y: y - 23 - index * 16, font: regular, size, color: ink }));
    return y - 23 - Math.min(lines.length, 2) * 16 - 5;
  };

  let y = 467;
  y = field('Bill to', data.company, y);
  y = field('Invoice', data.reference, y);
  y = field('Service', data.service, y);
  y = field('Paid on', data.paidAt, y);
  y = field('Payment method', data.method, y);
  page.drawLine({ start: { x: 64, y: 126 }, end: { x: 548, y: 126 }, thickness: 1, color: line });
  page.drawText(`Stripe payment ID: ${data.paymentId}`, { x: 64, y: 105, font: regular, size: 9, color: muted });
  page.drawText('Issued by LaunchPoint  |  mylaunch.dev', { x: 64, y: 81, font: regular, size: 9, color: muted });
  return pdf.save();
}

export default async (request: Request) => {
  if (request.method !== 'GET') return message('Method not allowed.', 405);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^pi_[A-Za-z0-9_]{10,80}$/.test(id)) return message('Receipt not found.', 404);
  const secret = Netlify.env.get('STRIPE_SECRET_KEY') || '';
  if (!secret) return message('Receipt is temporarily unavailable.', 503);
  try {
    const response = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(id)}?expand%5B%5D=latest_charge`, {
      headers: { authorization: `Bearer ${secret}` }
    });
    if (response.status === 404) return message('Receipt not found.', 404);
    if (!response.ok) return message('Receipt is temporarily unavailable.', 503);
    const data = receiptData(await response.json());
    if (!data) return message('A paid receipt is not available for this invoice.', 409);
    const pdf = await makePdf(data);
    return new Response(pdf, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="LaunchPoint-${data.reference.replace(/[^A-Za-z0-9-]/g, '')}-paid.pdf"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    });
  } catch {
    return message('Receipt is temporarily unavailable.', 503);
  }
};

export const config = {
  path: '/api/paid-receipt',
  method: 'GET',
  rateLimit: { action: 'rate_limit', windowLimit: 30, windowSize: 60, aggregateBy: ['domain', 'ip'] }
};
