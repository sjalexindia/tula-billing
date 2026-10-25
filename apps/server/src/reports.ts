import { todayIST, toPaise } from '@tula/core';
import type { Db } from '@tula/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cashBook, dayBook } from './reports/books';
import { monthRange, period, PeriodQuery, requireReportRole, type Report } from './reports/common';
import { cmp08, gstr1, gstr3b, quarterOf } from './reports/gst';
import { profitBy, profitLoss } from './reports/profit';
import { rateGroupReport, rateGroupsList } from './reports/rates';
import { purchaseRegister, salesRegister } from './reports/registers';
import { stockSummary } from './reports/stock';
import { reportWorkbook, xlsxFilename } from './reports/xlsx';

async function send(req: FastifyRequest, reply: FastifyReply, r: Report) {
  if ((req.query as { format?: string }).format !== 'xlsx') return r;
  const buf = await reportWorkbook(r);
  const name = xlsxFilename(r);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return reply
    .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    .send(buf);
}

const MonthQuery = PeriodQuery.extend({ month: z.string().optional() });
/** GST returns are monthly: ?month=YYYY-MM, else the month of `from`, else this month. */
const monthPeriod = (q: z.infer<typeof MonthQuery>) => monthRange(q.month ?? (q.from ?? todayIST()).slice(0, 7));

/** Registers, day book, stock valuation, profit and loss, profit by bill/customer/item, GST return exports. */
export function registerReports(app: FastifyInstance, db: Db, _deviceId: string): void {
  const route = <Q extends z.ZodTypeAny>(path: string, schema: Q, build: (q: z.infer<Q>) => Promise<Report>) => {
    app.get(`/api/reports/${path}`, async (req, reply) => {
      requireReportRole(req);
      const q = schema.parse(req.query);
      return send(req, reply, await build(q));
    });
  };

  route('day-book', PeriodQuery, (q) => { const p = period(q); return dayBook(db, p.from, p.to); });
  route('cash-book', PeriodQuery, (q) => { const p = period(q); return cashBook(db, p.from, p.to); });
  route('sales-register', PeriodQuery, (q) => { const p = period(q); return salesRegister(db, p.from, p.to); });
  route('purchase-register', PeriodQuery, (q) => { const p = period(q); return purchaseRegister(db, p.from, p.to); });
  route('stock-summary', PeriodQuery.extend({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), slowDays: z.coerce.number().int().min(1).max(3650).optional() }),
    (q) => stockSummary(db, q.asOf ?? q.to ?? todayIST(), q.slowDays ?? 60));
  route('profit-loss', PeriodQuery, (q) => { const p = period(q); return profitLoss(db, p.from, p.to); });
  route('profit', PeriodQuery.extend({ by: z.enum(['bill', 'customer', 'item']).optional() }),
    (q) => { const p = period(q); return profitBy(db, p.from, p.to, q.by ?? 'bill'); });
  route('rate-group', PeriodQuery.extend({ group: z.string().optional(), by: z.enum(['day', 'month']).optional() }),
    (q) => { const p = period(q); return rateGroupReport(db, p.from, p.to, q.group, q.by ?? 'day'); });
  route('gstr1', MonthQuery, (q) => { const p = monthPeriod(q); return gstr1(db, p.from, p.to); });
  route('gstr3b', MonthQuery, (q) => { const p = monthPeriod(q); return gstr3b(db, p.from, p.to); });
  route('cmp08', PeriodQuery.extend({ rate: z.string().optional() }), (q) => {
    const p = quarterOf(q.from ?? todayIST());
    return cmp08(db, p.from, p.to, toPaise(q.rate ?? '1'));
  });

  app.get('/api/reports/rate-groups', async (req) => {
    requireReportRole(req);
    return rateGroupsList(db);
  });
}
