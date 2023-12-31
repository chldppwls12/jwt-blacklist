import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginRequestDto } from '../dto/login-request.dto';
import { AuthRepository } from '../repository/auth.repository';
import * as bcrypt from 'bcrypt';
import { ErrMessage } from '../../common/enum';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenResponseDto } from '../dto/token-response.dto';
import { TokenPayloadDto } from '../dto/token-payload.dto';
import { CacheService } from '../../cache/service/cache.service';
import { JWT_BLACKLIST_KEY, REFRESH_TOKEN_KEY } from '../../common/constants';
import { SignUpRequestDto } from '../dto/signup-request.dto';

@Injectable()
export class AuthService {
  constructor(
    private authRepository: AuthRepository,
    private jwtService: JwtService,
    private configService: ConfigService,
    private cacheService: CacheService,
  ) {}

  async signup(requestDto: SignUpRequestDto): Promise<void> {
    if (!(await this.authRepository.isValidEmail(requestDto.email))) {
      throw new BadRequestException(ErrMessage.ALREADY_EXIST_EMAIL);
    }

    requestDto.password = await bcrypt.hash(requestDto.password, 10);
    await this.authRepository.createUser(requestDto);
  }

  async signTokens(payload: TokenPayloadDto): Promise<TokenResponseDto> {
    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken: this.jwtService.sign(payload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: this.configService.get<string>('REFRESH_TOKEN_EXPIRES_IN'),
      }),
    };
  }
  async login(requestDto: LoginRequestDto): Promise<TokenResponseDto> {
    const { email } = requestDto;
    const userId = await this.authRepository.findUserPk(email);
    if (!userId) {
      throw new UnauthorizedException(ErrMessage.INVALID_EMAIL_OR_PASSWORD);
    }

    const tokens = await this.signTokens({ email, userId });

    // redis에 refresh token 집어넣기
    await this.cacheService.set(
      `${REFRESH_TOKEN_KEY}:${userId}`,
      tokens.refreshToken,
      this.configService.get<number>('REFRESH_TOKEN_EXPIRES_IN'),
    );

    return tokens;
  }

  async validateUser(email: string, password: string) {
    // 이메일 확인
    if (!(await this.authRepository.isValidEmail(email))) {
      throw new UnauthorizedException(ErrMessage.INVALID_EMAIL_OR_PASSWORD);
    }

    // 비밀번호 확인
    const hashedPw = await this.authRepository.findUserHashedPw(email);
    if (!hashedPw) {
      throw new UnauthorizedException(ErrMessage.INVALID_EMAIL_OR_PASSWORD);
    }
    if (!(await bcrypt.compare(password, hashedPw))) {
      throw new UnauthorizedException(ErrMessage.INVALID_EMAIL_OR_PASSWORD);
    }

    return true;
  }

  async reissueTokens(user: TokenPayloadDto): Promise<TokenResponseDto> {
    const { userId } = user;

    // 유효한 유저인지 확인
    if (!userId) {
      throw new UnauthorizedException(ErrMessage.INVALID_TOKEN);
    }

    // 해당 refresh token이 redis에 존재하는지 확인
    if (!(await this.cacheService.get(`${REFRESH_TOKEN_KEY}:${userId}`))) {
      throw new UnauthorizedException(ErrMessage.INVALID_TOKEN);
    }

    return this.signTokens({
      userId,
      email: await this.authRepository.findUserEmailById(userId),
    });
  }

  async logout(user: TokenPayloadDto, accessToken: string): Promise<void> {
    await this.cacheService.sadd(
      JWT_BLACKLIST_KEY,
      accessToken,
      this.configService.get<number>('ACCESS_TOKEN_EXPIRES_IN'),
    );
  }
}
