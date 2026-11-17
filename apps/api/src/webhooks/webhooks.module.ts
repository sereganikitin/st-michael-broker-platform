import { BullModule } from '@nestjs/bull';
import { AMO_UNIQUENESS_QUEUE } from '../common/amo-uniqueness';
import { AmoUniquenessProcessor, AmoUniquenessRecoveryService } from './amo-uniqueness-recovery.service';
import { AmoReviewTaskService } from './amo-review-task.service';
import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule, BullModule.registerQueue({ name: AMO_UNIQUENESS_QUEUE })],
  controllers: [WebhooksController],
  providers: [WebhooksService, AmoUniquenessProcessor, AmoUniquenessRecoveryService, AmoReviewTaskService],
  exports: [AmoUniquenessRecoveryService],
})
export class WebhooksModule {}