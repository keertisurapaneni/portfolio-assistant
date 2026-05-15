-- Add credit-spread-focused tickers from OptionsPlay Growth Lab (Bryan Overby, May 2026).
-- AI/Semiconductors (sector leaders), Travel/Leisure (breakout sector), Utilities (dividend).

INSERT INTO options_watchlist (ticker, added_by, notes, tier) VALUES
  ('MRVL',  'credit_spread', 'Marvell Tech — AI/semi leader, strong momentum',           'GROWTH'),
  ('MU',    'credit_spread', 'Micron — memory/AI play, breakout after earnings',          'GROWTH'),
  ('ADI',   'credit_spread', 'Analog Devices — analog semi, steady growth',               'STABLE'),
  ('ON',    'credit_spread', 'ON Semiconductor — power/auto semi',                        'GROWTH'),
  ('HLT',   'credit_spread', 'Hilton — travel/leisure breakout sector',                   'STABLE'),
  ('MAR',   'credit_spread', 'Marriott — travel/leisure breakout sector',                 'STABLE'),
  ('NEE',   'credit_spread', 'NextEra Energy — utility/power grid, AI infrastructure',    'STABLE'),
  ('IWM',   'credit_spread', 'Russell 2000 ETF — small cap strength signal',              'STABLE'),
  ('VIK',   'credit_spread', 'Viking Holdings — cruise line breakout',                    'HIGH_VOL'),
  ('LRCX',  'credit_spread', 'Lam Research — semi equipment, CCI pullback entry',         'GROWTH')
ON CONFLICT (ticker) DO UPDATE SET
  notes = EXCLUDED.notes,
  active = true,
  updated_at = NOW();
