import { z } from 'zod';

export const TX_TYPES = ['buy', 'sell', 'dividend', 'split', 'transfer_in', 'transfer_out', 'fee', 'cash_in', 'cash_out', 'interest'] as const;
export type TxType = (typeof TX_TYPES)[number];
export const LOT_METHODS = ['FIFO', 'LIFO', 'HIFO', 'SPECIFIC'] as const;
export type LotMethod = (typeof LOT_METHODS)[number];

export const transactionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  /** trade date, YYYY-MM-DD */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(TX_TYPES),
  symbol: z.string().max(40).optional(),
  qty: z.number().nonnegative().optional(),
  price: z.number().nonnegative().optional(),
  /** cash amount (always positive; direction comes from `type`) */
  amount: z.number().nonnegative().optional(),
  fee: z.number().nonnegative().optional(),
  /** split ratio: new shares per old share (2 = 2-for-1, 0.1 = 1-for-10) */
  ratio: z.number().positive().optional(),
  /** specific-ID lot to sell from */
  lotId: z.string().optional(),
  note: z.string().max(500).optional(),
  source: z.string().max(60).optional(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  broker: z.string().max(40).optional(),
  currency: z.string().default('USD'),
  lotMethod: z.enum(LOT_METHODS).default('FIFO'),
});
export type Account = z.infer<typeof accountSchema>;

export interface Lot {
  id: string;
  accountId: string;
  symbol: string;
  openDate: string;
  qty: number;
  /** cost per share including allocated fees */
  cost: number;
}

export interface Realized {
  accountId: string;
  symbol: string;
  lotId: string;
  openDate: string;
  closeDate: string;
  qty: number;
  proceeds: number;
  cost: number;
  gain: number;
  term: 'short' | 'long';
}

export interface Income {
  accountId: string;
  date: string;
  symbol?: string;
  amount: number;
  kind: 'dividend' | 'interest';
}

export interface Position {
  symbol: string;
  qty: number;
  cost: number;
  avgCost: number;
  lots: Lot[];
  accounts: string[];
  firstDate: string;
}

export interface Ledger {
  lots: Lot[];
  realized: Realized[];
  income: Income[];
  cash: Record<string, number>;
  fees: number;
  positions: Position[];
  warnings: string[];
  /** external flows (deposits +, withdrawals −) by date, for XIRR/TWR */
  flows: { date: string; accountId: string; amount: number }[];
}
