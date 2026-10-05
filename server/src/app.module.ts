import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { ParsersService } from './services/parsers.service';
import { PortalService } from './services/portal.service';
import { AcademiaService } from './services/academia.service';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'frontend'),
      exclude: ['/api/(.*)', '/portal/(.*)'],
    }),
  ],
  controllers: [AppController],
  providers: [ParsersService, PortalService, AcademiaService],
})
export class AppModule {}
