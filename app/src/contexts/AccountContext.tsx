import { createContext, useContext, useState, type ReactNode } from 'react';

export type AccountView = 'live' | 'paper';

interface AccountContextValue {
  accountView: AccountView;
  setAccountView: (view: AccountView) => void;
  tradesTable: (view?: AccountView) => 'paper_trades' | 'live_trades';
  eventsTable: (view?: AccountView) => 'auto_trade_events' | 'live_trade_events';
}

function resolveTradesTable(view: AccountView): 'paper_trades' | 'live_trades' {
  return view === 'live' ? 'live_trades' : 'paper_trades';
}

function resolveEventsTable(view: AccountView): 'auto_trade_events' | 'live_trade_events' {
  return view === 'live' ? 'live_trade_events' : 'auto_trade_events';
}

const AccountContext = createContext<AccountContextValue>({
  accountView: 'paper',
  setAccountView: () => {},
  tradesTable: () => 'paper_trades',
  eventsTable: () => 'auto_trade_events',
});

export function AccountProvider({ children }: { children: ReactNode }) {
  const [accountView, setAccountView] = useState<AccountView>('paper');

  const value: AccountContextValue = {
    accountView,
    setAccountView,
    tradesTable: (view?: AccountView) => resolveTradesTable(view ?? accountView),
    eventsTable: (view?: AccountView) => resolveEventsTable(view ?? accountView),
  };

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccountView() {
  return useContext(AccountContext);
}
