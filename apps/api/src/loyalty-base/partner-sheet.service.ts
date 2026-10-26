import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PrismaClient } from "@st-michael/database";
import { join } from "node:path";

// Docker keeps the reviewed scripts at /app/scripts; the same relative
// root works in src and dist. No user input can influence these paths.
const { readSource } = require(
  join(__dirname, "../../../../scripts/partner-sheet/read-source.cjs"),
);
const { buildView } = require(
  join(__dirname, "../../../../scripts/partner-sheet/view.cjs"),
);

@Injectable()
export class PartnerSheetService {
  private cached: { expires: number; value: any } | null = null;
  private pending: Promise<any> | null = null;
  constructor(@Inject("PrismaClient") private readonly prisma: PrismaClient) {}

  async list() {
    if (this.cached && this.cached.expires > Date.now())
      return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async load() {
    try {
      const source = await readSource(
        JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}"),
      );
      const organizations = await this.prisma.agency.findMany({
        select: {
          id: true,
          name: true,
          legalName: true,
          inn: true,
          phone: true,
          email: true,
          address: true,
          legalAddress: true,
          bankName: true,
          bankBik: true,
          bankAccount: true,
          correspondentAccount: true,
          updatedAt: true,
        },
        take: 10001,
        orderBy: { id: "asc" },
      });
      if (organizations.length > 10000) throw new Error("TARGET_LIMIT");
      const value = buildView(source, organizations, new Date().toISOString());
      this.cached = { expires: Date.now() + 60000, value };
      return value;
    } catch {
      // Do not leak source payloads, service-account errors or DB details.
      throw new ServiceUnavailableException(
        "Не удалось обновить таблицу агентств. Повторите позже; текущая база не изменена.",
      );
    }
  }
}
