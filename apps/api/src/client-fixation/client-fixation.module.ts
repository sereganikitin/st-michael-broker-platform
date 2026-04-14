import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ClientFixationController } from './client-fixation.controller';
import { QuickFixController } from './quick-fix.controller';
import { ClientFixationService } from './client-fixation.service';
import { DatabaseModule } from '../database/database.module';
import { AmoCrmAdapter } from '@st-michael/integrations';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [ClientFixationController, QuickFixController],
  providers: [ClientFixationService, AmoCrmAdapter],
  exports: [ClientFixationService],
})
export class ClientFixationModule {}
