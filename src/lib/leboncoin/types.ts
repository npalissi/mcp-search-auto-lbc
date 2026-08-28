export type LeboncoinSearchLocation = {
  city?: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
};

export type LeboncoinSearchParams = {
  brand: string;
  model: string;
  lbcBrand?: string; // valeur exacte u_car_brand, ex. RENAULT
  lbcModel?: string; // valeur exacte u_car_model, ex. RENAULT_Clio
  yearMin?: number;
  yearMax?: number;
  mileageMin?: number;
  mileageMax?: number;
  fuel?: string; // codes LBC, ex. '1'=essence, '2'=diesel, '4'=électrique, '6'=hybride
  gearbox?: string; // '1'=manuelle, '2'=automatique
  priceMin?: number;
  priceMax?: number;
  ownerType?: "private" | "pro" | "all";
  location?: LeboncoinSearchLocation;
  maxPages?: number;
};

export type LeboncoinAttributeValue = string | number | boolean;

export type LeboncoinAd = {
  id: number;
  title: string;
  price: number; // euros
  url: string;
  mileage?: number;
  year?: number;
  fuel?: string;
  location?: string;
  lat?: number;
  lng?: number;
  department?: string;
  zipcode?: string;
  image?: string;
  images?: string[];
  description?: string;
  sellerType?: string;
  attributes?: Record<string, LeboncoinAttributeValue>;
  // v4 tracking fields (added by neptune — optional until deployed)
  last_price?: number; // previous price in euros (0 if new)
  is_active?: boolean; // false if ad was removed/sold
};

export type MarketValuation = {
  medianPrice: number;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  p25: number;
  p75: number;
  totalAds: number;
  totalBeforeFilter: number;
  totalExcluded: number;
  ads: LeboncoinAd[]; // all filtered ads, sorted by price asc
  searchParams: LeboncoinSearchParams;
  fetchedAt: string; // ISO date
  // v4 tracking (optional until deployed)
  newAds?: number;
  removedAds?: number;
};
