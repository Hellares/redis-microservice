import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, RpcException, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { envs } from './config/envs';
import { CONSOLE_COLORS } from './common/constants/colors.constants';


async function bootstrap() {
  const logger = new Logger ( `${CONSOLE_COLORS.TEXT.MAGENTA}Redis Microservice`);

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
      
    }
  );


  app.listen().then(() => {
    logger.log(`${CONSOLE_COLORS.TEXT.CYAN} Redis Microservice running on ${envs.port}`);
    logger.log(`${CONSOLE_COLORS.TEXT.GREEN} Connected to RabbitMQ`); // Añadimos log de conexión
  });
}
bootstrap();
