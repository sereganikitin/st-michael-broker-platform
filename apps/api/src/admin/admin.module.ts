import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { DatabaseModule } from '../database/database.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AmocrmModule, AuthModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
