export interface ProfitbaseLot {
  id: string;
  number: string;
  building: string;
  floor: number;
  rooms: string;
  sqm: number;
  price: number;
  status: string;
  layout_url?: string;
  plan_image_url?: string;
  description?: string;
  updated_at: string;
}

export interface LotFilters {
  project?: string;
  building?: string;
  floor?: number;
  rooms?: string;
  priceMin?: number;
  priceMax?: number;
  status?: string;
}

export interface IProfitbaseAdapter {
  getLots(filters?: LotFilters): Promise<ProfitbaseLot[]>;
  getLotById(id: string): Promise<ProfitbaseLot>;
  syncLots(): Promise<{ created: number; updated: number }>;
}

export class ProfitbaseAdapter implements IProfitbaseAdapter {
  // TODO: Implement actual Profitbase API integration
  async getLots(filters?: LotFilters): Promise<ProfitbaseLot[]> {
    console.log('ProfitbaseAdapter: getLots', filters);
    // Stub implementation
    return [
      {
        id: 'lot_1',
        number: '101',
        building: '1',
        floor: 1,
        rooms: 'Студия',
        sqm: 25.5,
        price: 4500000,
        status: 'available',
        description: 'Уютная студия',
        updated_at: new Date().toISOString(),
      },
      {
        id: 'lot_2',
        number: '102',
        building: '1',
        floor: 1,
        rooms: '1',
        sqm: 35.2,
        price: 6200000,
        status: 'available',
        description: 'Однокомнатная квартира',
        updated_at: new Date().toISOString(),
      },
    ];
  }

  async getLotById(id: string): Promise<ProfitbaseLot> {
    console.log('ProfitbaseAdapter: getLotById', id);
    // Stub implementation
    return {
      id,
      number: '101',
      building: '1',
      floor: 1,
      rooms: 'Студия',
      sqm: 25.5,
      price: 4500000,
      status: 'available',
      description: 'Уютная студия',
      updated_at: new Date().toISOString(),
    };
  }

  async syncLots(): Promise<{ created: number; updated: number }> {
    console.log('ProfitbaseAdapter: syncLots');
    // Stub implementation
    return {
      created: 5,
      updated: 3,
    };
  }
}