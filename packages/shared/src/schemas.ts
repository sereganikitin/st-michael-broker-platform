import { z } from 'zod';
import { UserRole, UserStatus, CommissionLevel, Project, UniquenessStatus, BrokerFunnelStage, BrokerSource, FixationStatus, ClientStatus, ContractType, DealStatus, LotStatus, CallDirection, CallStatus, CallResult, Sentiment, MeetingType, MeetingStatus, NotificationChannel, NotificationStatus } from './enums';

// Common schemas
export const phoneSchema = z.string().regex(/^\+7\d{10}$/, 'Invalid phone format (+7XXXXXXXXXX)');

export const emailSchema = z.string().email().optional();

export const uuidSchema = z.string().uuid();

// Auth schemas
export const registerDtoSchema = z.object({
  phone: phoneSchema,
  // Allow either composite fullName OR last/first/middle separately
  fullName: z.string().min(2).optional(),
  lastName: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  middleName: z.string().optional(),
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  inn: z.string().regex(/^\d{10}$|^\d{12}$/, 'INN must be 10 or 12 digits'),
  innType: z.enum(['PERSONAL', 'AGENCY']).optional(),
  agencyName: z.string().min(2).max(200).optional(),
}).refine((d) => d.fullName || (d.firstName && d.lastName), {
  message: 'Either fullName or firstName+lastName required',
});

export const forgotPasswordDtoSchema = z.object({
  email: z.string().email('Invalid email'),
});

export const resetPasswordDtoSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8),
});

export const sendOtpDtoSchema = z.object({
  phone: phoneSchema,
});

export const loginDtoSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1, 'Password required'),
});

export const refreshTokenDtoSchema = z.object({
  refreshToken: z.string(),
});

// Client fixation schemas
export const fixClientDtoSchema = z.object({
  phone: phoneSchema,
  fullName: z.string().min(2, 'Full name too short'),
  comment: z.string().optional(),
  project: z.nativeEnum(Project),
  agencyInn: z.string().regex(/^\d{10}$/, 'INN must be 10 digits'),
});

// Client schemas
export const createClientDtoSchema = z.object({
  fullName: z.string().min(2),
  phone: phoneSchema,
  email: emailSchema,
  comment: z.string().optional(),
  project: z.nativeEnum(Project),
});

export const updateClientDtoSchema = z.object({
  fullName: z.string().min(2).optional(),
  email: emailSchema,
  comment: z.string().optional(),
});

export const extendUniquenessDtoSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  comment: z.string().optional(),
});

export const resolveUniquenessDtoSchema = z.object({
  status: z.enum([UniquenessStatus.CONDITIONALLY_UNIQUE, UniquenessStatus.REJECTED]),
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

// Lot schemas
export const lotFiltersSchema = z.object({
  project: z.nativeEnum(Project).optional(),
  rooms: z.string().optional(),
  priceMin: z.number().positive().optional(),
  priceMax: z.number().positive().optional(),
  sqmMin: z.number().positive().optional(),
  sqmMax: z.number().positive().optional(),
  floor: z.number().int().positive().optional(),
  status: z.nativeEnum(LotStatus).optional(),
});

// Deal schemas
export const createDealDtoSchema = z.object({
  clientId: uuidSchema,
  lotId: uuidSchema.optional(),
  project: z.nativeEnum(Project),
  contractType: z.nativeEnum(ContractType).optional(),
  amount: z.number().positive(),
  sqm: z.number().positive(),
});

export const updateDealDtoSchema = z.object({
  contractType: z.nativeEnum(ContractType).optional(),
  amount: z.number().positive().optional(),
  sqm: z.number().positive().optional(),
  status: z.nativeEnum(DealStatus).optional(),
});

export const attachAgencyDtoSchema = z.object({
  agencyId: uuidSchema,
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

// Meeting schemas
export const createMeetingDtoSchema = z.object({
  clientId: uuidSchema,
  type: z.nativeEnum(MeetingType),
  // Either pick a configured slot...
  slotId: uuidSchema.optional(),
  // ...or supply a free-form datetime (legacy / manager override)
  date: z.string().datetime().optional(),
  comment: z.string().optional(),
  extraPhone: z.string().optional(),
  notifySms: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
  notifyReminder: z.boolean().optional(),
}).refine((d) => d.slotId || d.date, { message: 'slotId or date is required' });

export const updateMeetingDtoSchema = z.object({
  date: z.string().datetime().optional(),
  comment: z.string().optional(),
  status: z.nativeEnum(MeetingStatus).optional(),
  type: z.nativeEnum(MeetingType).optional(),
  extraPhone: z.string().optional(),
});

// Notification schemas
export const createNotificationDtoSchema = z.object({
  brokerId: uuidSchema,
  channel: z.nativeEnum(NotificationChannel),
  subject: z.string().optional(),
  body: z.string().min(1),
});

// Pagination schema
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// Commission calculation schema
export const commissionCalculationDtoSchema = z.object({
  amount: z.number().positive(),
  project: z.nativeEnum(Project),
  agencyInn: z.string().regex(/^\d{10}$/),
  isInstallment: z.boolean().default(false),
});

// Analytics schemas
export const analyticsFiltersSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  brokerId: uuidSchema.optional(),
  project: z.nativeEnum(Project).optional(),
});

export const funnelFiltersSchema = z.object({
  fixationCountMin: z.number().int().min(0).optional(),
  fixationCountMax: z.number().int().min(0).optional(),
  fixationDateFrom: z.string().datetime().optional(),
  fixationDateTo: z.string().datetime().optional(),
  brokerTourVisited: z.boolean().optional(),
  brokerTourDateFrom: z.string().datetime().optional(),
  brokerTourDateTo: z.string().datetime().optional(),
  meetingScheduled: z.boolean().optional(),
  dealClosed: z.boolean().optional(),
});

// Webhook schemas
export const amoLeadUpdateSchema = z.object({
  id: z.number(),
  status_id: z.number(),
  price: z.number().optional(),
  custom_fields: z.array(z.any()).optional(),
});

export const mangoCallResultSchema = z.object({
  call_id: z.string(),
  status: z.string(),
  duration: z.number().optional(),
  recording_url: z.string().optional(),
});

export const profitbaseLotUpdateSchema = z.object({
  id: z.string(),
  status: z.string(),
  price: z.number().optional(),
});

// Telegram bot schemas
export const telegramAuthDtoSchema = z.object({
  phone: phoneSchema,
  otp: z.string().length(4),
});

export const telegramFixClientDtoSchema = z.object({
  fullName: z.string().min(2),
  phone: phoneSchema,
  comment: z.string().optional(),
  agencyInn: z.string().regex(/^\d{10}$/),
});