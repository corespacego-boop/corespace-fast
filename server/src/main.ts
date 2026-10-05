process.on('unhandledRejection', (reason) => {
  console.warn('[Unhandled Rejection Ignored]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception Ignored]:', err);
});

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS for all domains
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const rawPort = process.env.PORT;
  const port = rawPort ? parseInt(rawPort, 10) : 8000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Corespace NestJS Server running on http://0.0.0.0:${port}`);
}
bootstrap();
