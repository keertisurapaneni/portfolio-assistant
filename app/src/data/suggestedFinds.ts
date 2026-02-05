import type { SuggestedStock } from '../types';

/**
 * Manually curated list of suggested stocks.
 * Updated periodically by the power user.
 *
 * Tag Definitions:
 * - Quiet Compounder: Steady ROIC > 15%, low volatility, boring business that compounds quietly
 * - Gold Mine: Theme-driven opportunities — stocks positioned to benefit from dominant market themes
 */

export interface ThemeCategory {
  name: string;
  description: string;
}

export interface EnhancedSuggestedStock extends SuggestedStock {
  whyGreat: string[]; // Bullet points explaining why this is a great find
  category?: string; // For Gold Mine: which part of the value chain
  metrics?: {
    label: string;
    value: string;
  }[];
}

// Current dominant theme for Gold Mine
export const currentTheme = {
  name: 'AI Infrastructure Build-Out',
  description:
    'As AI capex accelerates, companies across the value chain benefit from unprecedented demand for compute, memory, networking, and power infrastructure.',
  categories: [
    { name: 'Chips & Compute', description: 'GPUs, accelerators, custom silicon' },
    { name: 'Memory & Storage', description: 'HBM, high-bandwidth memory, enterprise storage' },
    { name: 'Networking', description: 'Data center interconnects, switches, optical' },
    { name: 'Power & Cooling', description: 'Power management, thermal solutions, infrastructure' },
    { name: 'Equipment & Tooling', description: 'Semiconductor equipment, packaging, foundry' },
  ],
};

export const quietCompounders: EnhancedSuggestedStock[] = [
  {
    ticker: 'ODFL',
    name: 'Old Dominion Freight Line',
    tag: 'Quiet Compounder',
    reason: 'Best-in-class LTL trucking, 20%+ ROIC, disciplined growth',
    whyGreat: [
      'Industry-leading operating ratio (~70%) vs competitors at 80%+',
      'Service quality creates pricing power — premium rates, premium margins',
      'Asset-light growth through owned terminals and driver training',
      'Boring business, exceptional execution — compounded 18% annually for 15 years',
    ],
    metrics: [
      { label: 'ROIC', value: '22%' },
      { label: 'Operating Ratio', value: '70%' },
      { label: '15yr CAGR', value: '18%' },
    ],
  },
  {
    ticker: 'POOL',
    name: 'Pool Corporation',
    tag: 'Quiet Compounder',
    reason: 'Swimming pool supplies monopoly, recurring revenue, 25+ year dividend growth',
    whyGreat: [
      'Dominant distributor with 40%+ market share in fragmented industry',
      'Installed base of 5M+ pools creates recurring maintenance demand',
      '80% of revenue is non-discretionary maintenance and repair',
      'Dividend aristocrat — 25+ consecutive years of increases',
    ],
    metrics: [
      { label: 'Market Share', value: '40%+' },
      { label: 'Recurring Rev', value: '80%' },
      { label: 'Div Growth', value: '25+ yrs' },
    ],
  },
  {
    ticker: 'WSO',
    name: 'Watsco Inc',
    tag: 'Quiet Compounder',
    reason: 'HVAC distribution leader, essential service, steady cash flows',
    whyGreat: [
      'Largest HVAC distributor in North America — essential infrastructure',
      'Replacement cycle (15-20 year AC lifespan) creates predictable demand',
      'Regulatory tailwinds: new refrigerant standards driving upgrades',
      'Consolidator of fragmented industry with proven M&A playbook',
    ],
    metrics: [
      { label: 'ROIC', value: '18%' },
      { label: 'FCF Margin', value: '8%' },
      { label: 'Div Yield', value: '2.5%' },
    ],
  },
  {
    ticker: 'TJX',
    name: 'TJX Companies',
    tag: 'Quiet Compounder',
    reason: 'Off-price retail king, recession-resistant, expanding margins',
    whyGreat: [
      'Off-price model thrives in both good times (treasure hunt) and bad (value seeking)',
      'Inventory model = no markdowns, fresh merchandise weekly',
      'Store economics: $10M revenue per store, rapid payback',
      'Recession-tested: outperformed in 2008 and 2020',
    ],
    metrics: [
      { label: 'Store Count', value: '4,900+' },
      { label: 'Same-store', value: '+5% avg' },
      { label: 'Gross Margin', value: '29%' },
    ],
  },
];

export const goldMineStocks: EnhancedSuggestedStock[] = [
  // Chips & Compute
  {
    ticker: 'AVGO',
    name: 'Broadcom Inc',
    tag: 'Gold Mine',
    reason: 'Custom AI accelerators for hyperscalers + networking dominance',
    category: 'Chips & Compute',
    whyGreat: [
      'Building custom AI chips (XPUs) for Google, Meta, ByteDance',
      'Networking: 70%+ share of data center switching silicon',
      'VMware acquisition adds enterprise software recurring revenue',
      'Management known for disciplined capital allocation and margins',
    ],
    metrics: [
      { label: 'AI Revenue', value: '$12B+' },
      { label: 'FCF Margin', value: '45%' },
      { label: 'Div Growth', value: '14 yrs' },
    ],
  },
  // Memory & Storage
  {
    ticker: 'MU',
    name: 'Micron Technology',
    tag: 'Gold Mine',
    reason: 'HBM memory leader — critical component in every AI GPU',
    category: 'Memory & Storage',
    whyGreat: [
      'High-bandwidth memory (HBM) is required for AI training — supply constrained',
      'HBM prices 5-10x higher than standard DRAM with better margins',
      'Memory content per AI server is 8x higher than traditional servers',
      'Oligopoly structure (Samsung, SK Hynix, Micron) supports pricing',
    ],
    metrics: [
      { label: 'HBM Share', value: '~25%' },
      { label: 'AI % Rev', value: 'Growing' },
      { label: 'P/E', value: '12x' },
    ],
  },
  // Networking
  {
    ticker: 'ANET',
    name: 'Arista Networks',
    tag: 'Gold Mine',
    reason: 'AI data center networking — backbone of hyperscaler infrastructure',
    category: 'Networking',
    whyGreat: [
      '400G/800G switches connect GPU clusters in AI data centers',
      'Meta, Microsoft are top customers — directly exposed to AI capex',
      '40%+ gross margins, zero debt, $4B+ cash',
      'Software-defined networking creates switching costs and recurring revenue',
    ],
    metrics: [
      { label: 'Cloud Rev', value: '75%' },
      { label: 'Gross Margin', value: '42%' },
      { label: 'Net Cash', value: '$4B+' },
    ],
  },
  // Power & Cooling
  {
    ticker: 'VRT',
    name: 'Vertiv Holdings',
    tag: 'Gold Mine',
    reason: 'Power and cooling for AI data centers — essential infrastructure',
    category: 'Power & Cooling',
    whyGreat: [
      'AI data centers need 3-5x more power and cooling than traditional',
      'Liquid cooling demand surging for high-density GPU racks',
      'Backlog at record levels — visibility into multi-year demand',
      'Underrated pure-play on data center infrastructure buildout',
    ],
    metrics: [
      { label: 'Backlog', value: '$6B+' },
      { label: 'Rev Growth', value: '20%+' },
      { label: 'AI Exposure', value: 'High' },
    ],
  },
  // Equipment & Tooling
  {
    ticker: 'AMAT',
    name: 'Applied Materials',
    tag: 'Gold Mine',
    reason: 'Semiconductor equipment leader — enabling next-gen AI chips',
    category: 'Equipment & Tooling',
    whyGreat: [
      'Every advanced AI chip requires AMAT equipment to manufacture',
      'Gate-all-around transistors and advanced packaging = new revenue drivers',
      'Services business (25% of rev) provides recurring revenue stability',
      'Beneficiary of both leading-edge AI and trailing-edge reshoring',
    ],
    metrics: [
      { label: 'Market Share', value: '19%' },
      { label: 'Services Rev', value: '25%' },
      { label: 'FCF Yield', value: '4%' },
    ],
  },
  {
    ticker: 'CRDO',
    name: 'Credo Technology',
    tag: 'Gold Mine',
    reason: 'High-speed connectivity for AI clusters — emerging leader',
    category: 'Networking',
    whyGreat: [
      'Active Electrical Cables (AECs) connect GPUs in AI clusters',
      'Customers: Microsoft, Amazon — directly tied to AI capex',
      '100%+ revenue growth as AI demand explodes',
      'Small cap with huge TAM runway as AI infrastructure scales',
    ],
    metrics: [
      { label: 'Rev Growth', value: '100%+' },
      { label: 'Gross Margin', value: '60%+' },
      { label: 'TAM', value: '$10B+' },
    ],
  },
];

// Combined for backward compatibility
export const suggestedFinds: SuggestedStock[] = [
  ...quietCompounders.map(s => ({
    ticker: s.ticker,
    name: s.name,
    tag: s.tag,
    reason: s.reason,
  })),
  ...goldMineStocks.map(s => ({
    ticker: s.ticker,
    name: s.name,
    tag: s.tag,
    reason: s.reason,
  })),
];
