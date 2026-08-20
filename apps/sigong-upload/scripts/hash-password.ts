/**
 * Generates the ADMIN_PASSWORD_HASH value for the single admin account.
 *
 *   npm run hash-password -- "사용할비밀번호"
 *
 * Copy the printed line into .env locally, or into the App Service
 * configuration (ideally as a Key Vault reference) for the deployed app.
 * The plaintext password is never stored anywhere by the application.
 */
import crypto from 'crypto';
import { hashPassword } from '../server/auth';

const password = process.argv[2];

if (!password) {
  console.error('사용법: npm run hash-password -- "<비밀번호>"');
  process.exit(1);
}

if (password.length < 12) {
  console.error('비밀번호는 12자 이상을 권장합니다. 더 긴 비밀번호를 사용해 주세요.');
  process.exit(1);
}

console.log('\n아래 두 값을 환경변수에 설정하세요:\n');
console.log(`ADMIN_PASSWORD_HASH="${hashPassword(password)}"`);
console.log(`ADMIN_SESSION_SECRET="${crypto.randomBytes(48).toString('base64url')}"`);
console.log('');
