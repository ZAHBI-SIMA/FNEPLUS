import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { chargerConfiguration } from './config.js';

async function demarrer(): Promise<void> {
  const config = chargerConfiguration();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 2 * 1024 * 1024 }),
    { logger: config.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : undefined },
  );

  // La PWA est servie depuis une autre origine en développement. En production,
  // l'origine autorisée sera celle du domaine applicatif, pas un joker.
  app.enableCors({
    origin: config.NODE_ENV === 'production' ? [/\.fneplus\.ci$/] : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  new Logger('Démarrage').log(
    `API FNE+ à l'écoute sur http://localhost:${config.PORT} (${config.NODE_ENV})`,
  );
}

await demarrer();
