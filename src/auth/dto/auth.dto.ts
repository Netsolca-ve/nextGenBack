import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(100)
  nombre: string;

  @IsString()
  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @MaxLength(100)
  apellido: string;

  @IsEmail({}, { message: 'El correo debe ser válido' })
  @IsNotEmpty({ message: 'El correo es obligatorio' })
  @MaxLength(150)
  correo: string;

  @IsString()
  @IsNotEmpty({ message: 'La clave es obligatoria' })
  @MinLength(8, { message: 'La clave debe tener al menos 8 caracteres' })
  @MaxLength(100)
  clave: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tipoIdentificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  identificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  telefono?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  direccion?: string;

  @IsOptional()
  @IsInt()
  idRol?: number;
}

export class LoginDto {
  @IsEmail({}, { message: 'El correo debe ser válido' })
  @IsNotEmpty({ message: 'El correo es obligatorio' })
  correo: string;

  @IsString()
  @IsNotEmpty({ message: 'La clave es obligatoria' })
  clave: string;
}
