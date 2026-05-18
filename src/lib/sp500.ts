export type Sp500Template = {
  symbol: string;
  issuer_name: string;
  sector: string;
  industry: string;
  exchange: "NYSE" | "NASDAQ";
};

const anchors: Sp500Template[] = [
  { symbol: "AAPL", issuer_name: "Apple Inc.", sector: "Information Technology", industry: "Technology Hardware", exchange: "NASDAQ" },
  { symbol: "MSFT", issuer_name: "Microsoft Corporation", sector: "Information Technology", industry: "Systems Software", exchange: "NASDAQ" },
  { symbol: "NVDA", issuer_name: "NVIDIA Corporation", sector: "Information Technology", industry: "Semiconductors", exchange: "NASDAQ" },
  { symbol: "AMZN", issuer_name: "Amazon.com Inc.", sector: "Consumer Discretionary", industry: "Broadline Retail", exchange: "NASDAQ" },
  { symbol: "META", issuer_name: "Meta Platforms Inc.", sector: "Communication Services", industry: "Interactive Media", exchange: "NASDAQ" },
  { symbol: "GOOGL", issuer_name: "Alphabet Inc. Class A", sector: "Communication Services", industry: "Interactive Media", exchange: "NASDAQ" },
  { symbol: "BRK.B", issuer_name: "Berkshire Hathaway Inc.", sector: "Financials", industry: "Multi-Sector Holdings", exchange: "NYSE" },
  { symbol: "LLY", issuer_name: "Eli Lilly and Company", sector: "Health Care", industry: "Pharmaceuticals", exchange: "NYSE" },
  { symbol: "AVGO", issuer_name: "Broadcom Inc.", sector: "Information Technology", industry: "Semiconductors", exchange: "NASDAQ" },
  { symbol: "JPM", issuer_name: "JPMorgan Chase & Co.", sector: "Financials", industry: "Diversified Banks", exchange: "NYSE" },
  { symbol: "V", issuer_name: "Visa Inc.", sector: "Financials", industry: "Transaction Processing", exchange: "NYSE" },
  { symbol: "XOM", issuer_name: "Exxon Mobil Corporation", sector: "Energy", industry: "Integrated Oil and Gas", exchange: "NYSE" },
  { symbol: "UNH", issuer_name: "UnitedHealth Group Incorporated", sector: "Health Care", industry: "Managed Health Care", exchange: "NYSE" },
  { symbol: "MA", issuer_name: "Mastercard Incorporated", sector: "Financials", industry: "Transaction Processing", exchange: "NYSE" },
  { symbol: "COST", issuer_name: "Costco Wholesale Corporation", sector: "Consumer Staples", industry: "Consumer Staples Merchandise Retail", exchange: "NASDAQ" },
  { symbol: "PG", issuer_name: "Procter & Gamble Company", sector: "Consumer Staples", industry: "Household Products", exchange: "NYSE" },
  { symbol: "HD", issuer_name: "Home Depot Inc.", sector: "Consumer Discretionary", industry: "Home Improvement Retail", exchange: "NYSE" },
  { symbol: "NFLX", issuer_name: "Netflix Inc.", sector: "Communication Services", industry: "Movies and Entertainment", exchange: "NASDAQ" },
  { symbol: "BAC", issuer_name: "Bank of America Corporation", sector: "Financials", industry: "Diversified Banks", exchange: "NYSE" },
  { symbol: "ABBV", issuer_name: "AbbVie Inc.", sector: "Health Care", industry: "Biotechnology", exchange: "NYSE" },
  { symbol: "KO", issuer_name: "Coca-Cola Company", sector: "Consumer Staples", industry: "Soft Drinks", exchange: "NYSE" },
  { symbol: "CRM", issuer_name: "Salesforce Inc.", sector: "Information Technology", industry: "Application Software", exchange: "NYSE" },
  { symbol: "ORCL", issuer_name: "Oracle Corporation", sector: "Information Technology", industry: "Systems Software", exchange: "NYSE" },
  { symbol: "WMT", issuer_name: "Walmart Inc.", sector: "Consumer Staples", industry: "Consumer Staples Merchandise Retail", exchange: "NYSE" },
  { symbol: "AMD", issuer_name: "Advanced Micro Devices Inc.", sector: "Information Technology", industry: "Semiconductors", exchange: "NASDAQ" },
  { symbol: "PEP", issuer_name: "PepsiCo Inc.", sector: "Consumer Staples", industry: "Soft Drinks", exchange: "NASDAQ" },
  { symbol: "CSCO", issuer_name: "Cisco Systems Inc.", sector: "Information Technology", industry: "Communications Equipment", exchange: "NASDAQ" },
  { symbol: "MCD", issuer_name: "McDonald's Corporation", sector: "Consumer Discretionary", industry: "Restaurants", exchange: "NYSE" },
  { symbol: "TMO", issuer_name: "Thermo Fisher Scientific Inc.", sector: "Health Care", industry: "Life Sciences Tools", exchange: "NYSE" },
  { symbol: "ABT", issuer_name: "Abbott Laboratories", sector: "Health Care", industry: "Health Care Equipment", exchange: "NYSE" },
  { symbol: "LIN", issuer_name: "Linde plc", sector: "Materials", industry: "Industrial Gases", exchange: "NASDAQ" },
  { symbol: "DIS", issuer_name: "Walt Disney Company", sector: "Communication Services", industry: "Movies and Entertainment", exchange: "NYSE" },
  { symbol: "GE", issuer_name: "GE Aerospace", sector: "Industrials", industry: "Aerospace and Defense", exchange: "NYSE" },
  { symbol: "CAT", issuer_name: "Caterpillar Inc.", sector: "Industrials", industry: "Construction Machinery", exchange: "NYSE" },
  { symbol: "NEE", issuer_name: "NextEra Energy Inc.", sector: "Utilities", industry: "Electric Utilities", exchange: "NYSE" }
];

const sectorMix = [
  { sector: "Information Technology", industry: "Systems Software", weight: 30 },
  { sector: "Financials", industry: "Financial Services", weight: 13 },
  { sector: "Health Care", industry: "Health Care Equipment", weight: 12 },
  { sector: "Consumer Discretionary", industry: "Specialty Retail", weight: 10 },
  { sector: "Communication Services", industry: "Interactive Media", weight: 9 },
  { sector: "Industrials", industry: "Industrial Machinery", weight: 8 },
  { sector: "Consumer Staples", industry: "Packaged Foods", weight: 6 },
  { sector: "Energy", industry: "Oil and Gas", weight: 4 },
  { sector: "Utilities", industry: "Electric Utilities", weight: 3 },
  { sector: "Real Estate", industry: "REITs", weight: 3 },
  { sector: "Materials", industry: "Specialty Chemicals", weight: 2 }
] as const;

const prefixes = ["Apex", "Pioneer", "Summit", "Vertex", "Meridian", "Harbor", "Northstar", "Catalyst"];
const suffixes = ["Systems", "Holdings", "Group", "Industries", "Networks", "Partners", "Technologies", "Resources"];

export function makeSp500Template(index: number): Sp500Template {
  if (index < anchors.length) return anchors[index];

  const sector = sectorForIndex(index);
  const issuer = `${prefixes[index % prefixes.length]} ${sector.industry} ${suffixes[index % suffixes.length]} Inc.`;

  return {
    symbol: makeSymbol(issuer, index),
    issuer_name: issuer,
    sector: sector.sector,
    industry: sector.industry,
    exchange: index % 3 === 0 ? "NYSE" : "NASDAQ"
  };
}

function sectorForIndex(index: number): (typeof sectorMix)[number] {
  const total = sectorMix.reduce((sum, item) => sum + item.weight, 0);
  let cursor = index % total;
  for (const item of sectorMix) {
    if (cursor < item.weight) return item;
    cursor -= item.weight;
  }
  return sectorMix[0];
}

function makeSymbol(name: string, index: number): string {
  const letters = name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
  return `${letters}${String(index).slice(-2)}`;
}
