import { Controller, Post, Get, Patch, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from './current-user.decorator';
import { registerDtoSchema, loginDtoSchema, phoneSchema, forgotPasswordDtoSchema, resetPasswordDtoSchema } from '@st-michael/shared';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register broker' })
  @ApiResponse({ status: 201, description: 'Broker registered, OTP sent' })
  async register(@Body() body: unknown) {
    const data = registerDtoSchema.parse(body) as { phone: string; fullName: string; email?: string; password: string; inn?: string; innType?: 'PERSONAL' | 'AGENCY'; agencyName?: string };
    return this.authService.register(data);
  }

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP to registered broker' })
  @ApiResponse({ status: 200, description: 'OTP sent' })
  async sendOtp(@Body() body: unknown) {
    const { phone } = { phone: phoneSchema.parse((body as any)?.phone) };
    return this.authService.sendOtp(phone);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with phone and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  async login(@Body() body: unknown) {
    const data = loginDtoSchema.parse(body) as { phone: string; password: string };
    return this.authService.login(data);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset link via email' })
  async forgotPassword(@Body() body: unknown) {
    const { email } = forgotPasswordDtoSchema.parse(body);
    return this.authService.forgotPassword(email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token from email' })
  async resetPassword(@Body() body: unknown) {
    const { token, password } = resetPasswordDtoSchema.parse(body);
    return this.authService.resetPassword(token, password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  async refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refreshToken(body.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Current user data' })
  async getProfile(@CurrentUser() user: CurrentUserPayload) {
    return this.authService.getProfile(user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  async updateProfile(@CurrentUser() user: CurrentUserPayload, @Body() body: any) {
    return this.authService.updateProfile(user.id, {
      fullName: body.fullName,
      email: body.email,
      phone: body.phone,
    });
  }
}
