import { Module } from "@nestjs/common";
import { CacheController } from "src/controllers/cache.controller";
import { CacheService } from "src/services/cache.service";
import { CircuitBreakerService } from "src/services/circuit-breaker.service";
import { RetryService } from "src/services/retry-service";

@Module({
  imports: [],
  controllers:[CacheController,],
  providers: [
    CacheService, 
    CircuitBreakerService,
    RetryService, 
    
  ],
  exports: [CacheService]
})
export class CacheModule {}