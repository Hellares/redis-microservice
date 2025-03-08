import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, RpcException, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { envs } from './config/envs';


async function bootstrap() {
  const nestLogger = new Logger('Redis Microservice');

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(

    AppModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: envs.rabbitmqServers,
        queue: 'redis_queue',
        queueOptions: {
          durable: true,
        },
        noAck: false,     
      },
      bufferLogs: true, // Añadimos bufferLogs para que muestre los logs con pino
    }
  );

  app.listen().then(() => {
    nestLogger.log('Redis Microservice running on ' + envs.port);
    nestLogger.log('Connected to RabbitMQ');
  });
}
bootstrap();
