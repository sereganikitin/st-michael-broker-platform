import { Module } from '@nestjs/common';
import { BrokerCallsController } from './broker-calls.controller';
import { BrokerCallsService } from './broker-calls.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [BrokerCallsController],
  providers: [BrokerCallsService],
})
export class BrokerCallsModule {}
