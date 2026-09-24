import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SmsService } from './sms.service.js';
import { JETON_CONFIG } from '../db/db.module.js';
import type { Configuration } from '../config.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [JETON_CONFIG],
      useFactory: (config: Configuration) => ({
        secret: config.JWT_SECRET,
        signOptions: { expiresIn: config.JWT_DUREE_SECONDES },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SmsService],
  exports: [AuthService, SmsService, JwtModule],
})
export class AuthModule {}
