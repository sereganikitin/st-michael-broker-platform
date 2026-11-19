import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@st-michael/database";
import { findLatestFixationBrokerId } from "../common/latest-fixation-broker";

type AssignmentDatabase = Pick<PrismaClient, "broker" | "$queryRaw">;
const brokerWithAgency = {
  brokerAgencies: {
    where: { isPrimary: true },
    include: { agency: true },
    take: 1,
  },
} as const;

/** Validate the local destination before granting access or calling amoCRM. */
export async function resolveFixationBrokers(
  prisma: AssignmentDatabase,
  actorId: string,
  requestedBrokerId?: string,
  pinned = false,
) {
  const broker = await prisma.broker.findUnique({
    where: { id: actorId },
    include: brokerWithAgency,
  });
  if (!broker || broker.status === "BLOCKED" || broker.mergedIntoId) {
    throw new BadRequestException("Пользователь, подавший заявку, недоступен");
  }
  if (!requestedBrokerId || requestedBrokerId === actorId) {
    return { broker, responsibleBroker: broker };
  }
  let candidate = await prisma.broker.findUnique({
    where: { id: requestedBrokerId },
    include: brokerWithAgency,
  });
  if (!candidate || candidate.role !== "BROKER") {
    throw new BadRequestException("Указанный ответственный брокер не найден");
  }
  // Once accepted, a request keeps its verified ID even if phone lookup later
  // selects a newer card. A merged/blocked destination requires staff review.
  if (!pinned) {
    const latestId = await findLatestFixationBrokerId(prisma, candidate.phone);
    if (latestId && latestId !== candidate.id) {
      candidate = await prisma.broker.findUnique({
        where: { id: latestId },
        include: brokerWithAgency,
      });
    }
  }
  if (!candidate || candidate.role !== "BROKER" || candidate.mergedIntoId) {
    throw new BadRequestException(
      "Карточка ответственного брокера изменилась — требуется проверка сотрудником",
    );
  }
  if (candidate.status === "BLOCKED") {
    throw new BadRequestException(
      "Указанный ответственный брокер заблокирован",
    );
  }
  return { broker, responsibleBroker: candidate };
}
