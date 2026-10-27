import type { ComponentType } from 'react';
import type { Role } from './api';
import { Backup } from './screens/Backup';
import { Bills } from './screens/Bills';
import { Customers } from './screens/Customers';
import { Devices } from './screens/Devices';
import { Adjustments } from './screens/Adjustments';
import { Excel } from './screens/Excel';
import { Help } from './screens/Help';
import { Expenses } from './screens/Expenses';
import { Items } from './screens/Items';
import { NewBill } from './screens/NewBill';
import { OpeningStock } from './screens/OpeningStock';
import { Outstanding } from './screens/Outstanding';
import { Purchases } from './screens/Purchases';
import { NewQuote, Quotes } from './screens/Quotes';
import { Receipts } from './screens/Receipts';
import { RecycleBin } from './screens/RecycleBin';
import { Reports } from './screens/Reports';
import { SettingsScreen } from './screens/Settings';
import { Statement } from './screens/Statement';
import { Stock } from './screens/Stock';
import { SupplierPayments } from './screens/SupplierPayments';

/** Every screen gets the optional id from the URL (#/route/id). */
export type ScreenProps = { id?: string; ratesVersion: number };

export interface NavItem {
  route: string;
  /** translation key for the menu label */
  label: string;
  /** 'help' is no tab: Help opens from the ? button, so no menu group lights up under it */
  group: 'billing' | 'purchases' | 'stock' | 'reports' | 'masters' | 'settings' | 'help';
  roles: Role[];
  screen: ComponentType<ScreenProps>;
  /** reachable by link only, not shown in the menu (e.g. a statement) */
  hidden?: boolean;
  /** needs the shop computer itself (files, backups); left out when Tula runs on a phone */
  computerOnly?: boolean;
}

const ALL: Role[] = ['owner', 'billing', 'viewer'];
const STAFF: Role[] = ['owner', 'billing'];
const OWNER_VIEW: Role[] = ['owner', 'viewer'];
const OWNER: Role[] = ['owner'];

/**
 * The one list of screens. Order within a group is menu order; the first screen a role
 * can see is its home screen. Print views (invoice) are routed separately in App.tsx.
 */
export const NAV: NavItem[] = [
  { route: '', label: 'nav.newBill', group: 'billing', roles: STAFF, screen: NewBill },
  { route: 'bills', label: 'nav.bills', group: 'billing', roles: ALL, screen: Bills },
  { route: 'quotes', label: 'nav.quotes', group: 'billing', roles: ALL, screen: Quotes },
  { route: 'quote', label: 'nav.newQuote', group: 'billing', roles: STAFF, screen: NewQuote, hidden: true },
  { route: 'receipts', label: 'nav.receipts', group: 'billing', roles: ALL, screen: Receipts },
  { route: 'outstanding', label: 'nav.outstanding', group: 'billing', roles: ALL, screen: Outstanding },
  { route: 'statement', label: 'nav.statement', group: 'billing', roles: ALL, screen: Statement, hidden: true },

  { route: 'purchases', label: 'nav.purchases', group: 'purchases', roles: OWNER_VIEW, screen: Purchases },
  { route: 'payments', label: 'nav.payments', group: 'purchases', roles: OWNER_VIEW, screen: SupplierPayments },
  { route: 'expenses', label: 'nav.expenses', group: 'purchases', roles: OWNER_VIEW, screen: Expenses },

  { route: 'stock', label: 'nav.stock', group: 'stock', roles: ALL, screen: Stock },
  { route: 'adjustments', label: 'nav.adjustments', group: 'stock', roles: OWNER_VIEW, screen: Adjustments },
  { route: 'opening', label: 'nav.opening', group: 'stock', roles: OWNER, screen: OpeningStock },

  { route: 'reports', label: 'nav.reports', group: 'reports', roles: OWNER_VIEW, screen: Reports },

  { route: 'items', label: 'nav.items', group: 'masters', roles: ALL, screen: Items },
  { route: 'customers', label: 'nav.customers', group: 'masters', roles: ALL, screen: Customers },
  { route: 'excel', label: 'nav.excel', group: 'masters', roles: OWNER, screen: Excel },

  { route: 'settings', label: 'nav.settings', group: 'settings', roles: OWNER, screen: SettingsScreen },
  { route: 'backup', label: 'nav.backup', group: 'settings', roles: OWNER, screen: Backup, computerOnly: true },
  { route: 'devices', label: 'nav.devices', group: 'settings', roles: OWNER, screen: Devices },
  { route: 'recycle', label: 'nav.recycle', group: 'settings', roles: OWNER, screen: RecycleBin },
  // opened from the ? button in the top bar and the user menu, for every role
  { route: 'help', label: 'nav.help', group: 'help', roles: ALL, screen: Help, hidden: true },
];

export const GROUP_ORDER: NavItem['group'][] = ['billing', 'purchases', 'stock', 'reports', 'masters', 'settings'];
