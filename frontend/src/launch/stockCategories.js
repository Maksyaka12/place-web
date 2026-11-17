// Categories of tokenized stocks on the Stocks page. The Coinbase Tokenized Stocks API has no sector, so each
// ticker (without the trailing `c` of the token symbol) is placed in one category here. A ticker that is not
// listed still shows under All stocks.
export const STOCK_CATEGORIES = [
  { id: 'big-tech', label: 'Big tech', tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'IBM'] },
  {
    id: 'ai-chips',
    label: 'AI & chips',
    tickers: [
      'AMD', 'SKHY', 'ARM', 'NVTS', 'AMKR', 'LRCX', 'SNDK', 'ALAB', 'INTC', 'QCOM', 'SMCI', 'TER', 'TTMI', 'AI', 'ON',
      'WOLF', 'WDC', 'AMAT', 'AXTI', 'COHR', 'ACMR', 'ADI', 'AAOI', 'KLAC', 'MRVL', 'LITE', 'PENG', 'MU', 'AVGO', 'AEHR',
      'SOUN', 'BBAI', 'QBTS', 'IONQ', 'RGTI', 'QUBT', 'CRWV', 'APLD', 'SHAZ', 'TEM', 'PLTR', 'GLW', 'CIEN', 'ANET',
      'VRT', 'DELL', 'HPE', 'HPQ', 'CSCO',
    ],
  },
  {
    id: 'crypto',
    label: 'Crypto economy',
    tickers: [
      'TRON', 'XXI', 'CRCL', 'CORZ', 'ASST', 'MSTR', 'WULF', 'SBET', 'GLXY', 'HUT', 'BNC', 'USDE', 'MARA', 'RIOT', 'BMNR',
      'CLSK', 'CAN', 'CIFR', 'PURR', 'FWDI',
    ],
  },
  { id: 'ipo', label: 'IPOs & pre-IPO', tickers: ['SPCX', 'FIG', 'KRMN', 'OPNW', 'QNT', 'CBRS', 'INFQ', 'FIGR', 'GEMI'] },
  { id: 'china', label: 'China', tickers: ['NIO', 'BIDU', 'PDD', 'BILI', 'LI', 'WRD', 'HSAI'] },
  { id: 'international', label: 'International', tickers: ['SAN', 'UL', 'NOK', 'VALE', 'SAP', 'SONY', 'NVO', 'BUD', 'INFY', 'SE', 'CPNG', 'OPRA'] },
  {
    id: 'space-defense',
    label: 'Space & defense',
    tickers: ['SIDU', 'LUNR', 'SPCE', 'RKLB', 'ASTS', 'BKSY', 'PL', 'RDW', 'GSAT', 'AXON', 'RTX', 'BA', 'RCAT', 'UMAC', 'ONDS', 'SWBI', 'VOYG', 'FLY'],
  },
  {
    id: 'energy',
    label: 'Energy & power',
    tickers: ['BE', 'CVX', 'XOM', 'FLNC', 'NNE', 'VST', 'ENPH', 'OKLO', 'SMR', 'FSLR', 'RUN', 'PLUG', 'CEG', 'LEU', 'COP', 'PR', 'WTI', 'PUMP'],
  },
  {
    id: 'cloud',
    label: 'Cloud & software',
    tickers: [
      'DOCN', 'APP', 'ZM', 'OKTA', 'DDOG', 'ADBE', 'ORCL', 'TEAM', 'SNOW', 'CRM', 'PATH', 'ZS', 'NOW', 'MDB', 'PANW', 'TTD',
      'S', 'U', 'INTU', 'CRWD', 'GTLB', 'RBRK', 'IT', 'KD',
    ],
  },
  {
    id: 'finance',
    label: 'Finance & fintech',
    tickers: [
      'RKT', 'SEZL', 'PYPL', 'WU', 'SOFI', 'XYZ', 'HOOD', 'UPST', 'AFRM', 'V', 'AXP', 'GS', 'JPM', 'BAC', 'BX', 'OWL', 'ALL',
      'ROOT', 'DAVE', 'BRK.B', 'FOUR', 'OPEN', 'OPAD', 'COMP', 'EVER', 'YOU',
    ],
  },
  {
    id: 'consumer',
    label: 'Consumer & retail',
    tickers: [
      'FUN', 'ABNB', 'BJ', 'KSS', 'PLNT', 'SMPL', 'STZ', 'CAVA', 'ANF', 'BROS', 'REAL', 'WING', 'CELH', 'CROX', 'WEN', 'GRPN',
      'ULTA', 'MNST', 'DNUT', 'YUM', 'AEO', 'YETI', 'WHR', 'PZZA', 'ELF', 'PEP', 'NKE', 'BALL', 'EBAY', 'BYND', 'EAT', 'RH',
      'DKS', 'UAA', 'PLAY', 'WW', 'W', 'WMT', 'PM', 'OLLI', 'LULU', 'CHWY', 'KMB', 'VSXY', 'HD', 'JACK', 'SG', 'WOOF', 'DECK',
      'ETSY', 'GAP', 'PG', 'SBUX', 'LOVE', 'TGT', 'MED', 'MCD', 'TAP', 'SAM', 'CMG', 'SPB', 'FIZZ', 'CAKE', 'HSY', 'KO', 'VVV',
      'BOOT', 'DASH', 'GPRO', 'PTON',
    ],
  },
  {
    id: 'media',
    label: 'Media & gaming',
    tickers: ['DIS', 'RUM', 'LYV', 'PINS', 'SNAP', 'DJT', 'GAME', 'RBLX', 'RDDT', 'GME', 'BZFD', 'TKO', 'SKYD', 'AMC', 'FUBO', 'TTWO', 'KODK', 'CMCSA', 'NFLX', 'DUOL'],
  },
  {
    id: 'mobility',
    label: 'Future mobility',
    tickers: [
      'LYFT', 'TSLA', 'HOG', 'HTZ', 'RIVN', 'AAL', 'JBLU', 'LCID', 'ACHR', 'CHPT', 'BLNK', 'QS', 'ENVX', 'SLDP', 'WKHS', 'F',
      'UBER', 'AUR', 'UAL', 'LUV', 'MVIS', 'OUST', 'GT', 'CVNA', 'SERV', 'RR',
    ],
  },
  {
    id: 'health',
    label: 'Health & biotech',
    tickers: [
      'SLS', 'ABSI', 'OMER', 'PFE', 'DHR', 'MRK', 'ISRG', 'TGTX', 'HIMS', 'AMGN', 'RXRX', 'NTLA', 'REGN', 'BIIB', 'IBRX',
      'MDGL', 'JNJ', 'SRPT', 'VKTX', 'GILD', 'TWST', 'VRTX', 'IRON', 'UNH', 'NVAX', 'WGS', 'DNA', 'ABT', 'BEAM', 'LFMD',
      'MRNA', 'LLY', 'TDOC', 'CLOV',
    ],
  },
  {
    id: 'industrials',
    label: 'Industrials',
    tickers: ['QXO', 'ALNT', 'CGNX', 'ROK', 'TKR', 'VPG', 'BIRD', 'NDSN', 'CAT', 'GE', 'EMR', 'ZBRA', 'SYM', 'MP', 'USAR', 'CLF', 'HYMC', 'NEM'],
  },
];

const BY_TICKER = new Map(STOCK_CATEGORIES.flatMap((c) => c.tickers.map((t) => [t, c.id])));

/** The ticker of a stock token symbol: `NVDAc` → `NVDA`. */
export const stockTicker = (symbol) => String(symbol || '').replace(/c$/, '');

/** The category id of a stock token symbol, or null. */
export const stockCategory = (symbol) => BY_TICKER.get(stockTicker(symbol)) ?? null;
