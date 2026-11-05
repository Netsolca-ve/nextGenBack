import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '../database/database.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

type UserRecord = {
  idUsuario: number;
  nombre: string;
  apellido: string;
  correo: string;
  tipoIdentificacion: string | null;
  identificacion: string | null;
  telefono: string | null;
  direccion: string | null;
  idRol: number | null;
  creadoEl: Date;
  actualizadoEl: Date;
  clave: string;
};

@Injectable()
export class AuthService {
  private readonly saltRounds = 12;

  constructor(private readonly db: DatabaseService) {}

  async register(dto: RegisterDto) {
    const correo = dto.correo.trim().toLowerCase();
    const existingUsers = await this.db.query<{ idUsuario: number }>(
      'SELECT idUsuario FROM usuarios WHERE correo = ? LIMIT 1',
      [correo],
    );

    if (existingUsers.length > 0) {
      throw new ConflictException('El correo ya está registrado');
    }

    const hashedPassword = await bcrypt.hash(dto.clave, this.saltRounds);
    const result: any = await this.db.query(
      `INSERT INTO usuarios (
        nombre, apellido, correo, tipoIdentificacion, identificacion,
        clave, telefono, direccion, idRol
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dto.nombre.trim(),
        dto.apellido.trim(),
        correo,
        dto.tipoIdentificacion ?? null,
        dto.identificacion ?? null,
        hashedPassword,
        dto.telefono ?? null,
        dto.direccion ?? null,
        dto.idRol ?? null,
      ],
    );

    const user = await this.getUserById(result.insertId);
    return {
      message: 'Usuario registrado con éxito',
      user: this.toPublicUser(user),
    };
  }

  async login(dto: LoginDto) {
    const correo = dto.correo.trim().toLowerCase();
    const users = await this.db.query<UserRecord>(
      `SELECT
        idUsuario, nombre, apellido, correo, tipoIdentificacion,
        identificacion, clave, telefono, direccion, idRol, creadoEl, actualizadoEl
      FROM usuarios
      WHERE correo = ?
      LIMIT 1`,
      [correo],
    );

    const user = users[0];
    if (!user || !(await bcrypt.compare(dto.clave, user.clave))) {
      throw new UnauthorizedException('Correo o clave incorrectos');
    }

    return {
      message: 'Inicio de sesión exitoso',
      user: this.toPublicUser(user),
    };
  }

  private async getUserById(idUsuario: number) {
    const users = await this.db.query<UserRecord>(
      `SELECT
        idUsuario, nombre, apellido, correo, tipoIdentificacion,
        identificacion, clave, telefono, direccion, idRol, creadoEl, actualizadoEl
      FROM usuarios
      WHERE idUsuario = ?
      LIMIT 1`,
      [idUsuario],
    );

    if (!users[0]) {
      throw new Error('El usuario fue creado, pero no pudo ser recuperado');
    }

    return users[0];
  }

  private toPublicUser(user: UserRecord) {
    const { clave, ...publicUser } = user;
    return publicUser;
  }
}
