import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { existsSync } from 'fs';
import { AppController } from './app.controller';
import { ParsersService } from './services/parsers.service';
import { PortalService } from './services/portal.service';
import { AcademiaService } from './services/academia.service';

const getStaticPath = (): string => {
  const candidates = [
    join(__dirname, '..', 'public'),
    join(process.cwd(), 'public'),
    join(process.cwd(), 'server', 'public'),
    join(__dirname, '..', '..', 'frontend'),
    join(process.cwd(), 'frontend'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      console.log(`[Static Files] Serving frontend from: ${candidate}`);
      return candidate;
    }
  }

  const fallback = join(__dirname, '..', 'public');
  console.log(`[Static Files] Fallback to: ${fallback}`);
  return fallback;
};

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: getStaticPath(),
      exclude: ['/api/(.*)', '/portal/(.*)'],
    }),
  ],
  controllers: [AppController],
  providers: [ParsersService, PortalService, AcademiaService],
})
export class AppModule {}
