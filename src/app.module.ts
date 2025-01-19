import { Module } from '@nestjs/common';
import { CacheController } from './controllers/cache.controller';
import { CacheModule } from './module/cache-module';
import { cache } from 'joi';

@Module({
  imports: [
    CacheModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
