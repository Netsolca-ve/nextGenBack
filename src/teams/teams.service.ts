import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  CreateTeamDto,
  UpdateTeamDto,
  CreatePlayerDto,
  UpdatePlayerDto,
} from './dto/teams.dto';

@Injectable()
export class TeamsService {
    constructor(private readonly db: DatabaseService) {}

async getAllTeams() {
    const sql = `
      SELECT 
        e.idEquipo,
        e.nombre,
        e.slug,
        e.siglas,
        e.categoria,
        e.logo,
        e.colorLocal,
        e.colorVisitante,
        e.horarioEntrenamientos,
        e.diasEntrenamientos,
        e.idAcademia,
        a.nombre AS nombreAcademia,
        e.idEntrenador,
        CONCAT(ent.nombre, ' ', ent.apellido) AS nombreEntrenador,
        COUNT(j.idJugador) AS totalJugadores
      FROM Equipos e
      LEFT JOIN academias a ON a.idAcademia = e.idAcademia
      LEFT JOIN Entrenadores ent ON ent.idEntrenador = e.idEntrenador
      LEFT JOIN jugadores j ON j.idEquipo = e.idEquipo
      GROUP BY e.idEquipo
      ORDER BY e.nombre ASC;
    `;
    return this.db.query(sql);
  }

  async getTeamById(idEquipo: number) {
    const sql = `
      SELECT 
        e.idEquipo,
        e.nombre,
        e.slug,
        e.siglas,
        e.categoria,
        e.logo,
        e.colorLocal,
        e.colorVisitante,
        e.horarioEntrenamientos,
        e.diasEntrenamientos,
        e.idAcademia,
        a.nombre AS nombreAcademia,
        e.idEntrenador,
        CONCAT(ent.nombre, ' ', ent.apellido) AS nombreEntrenador
      FROM Equipos e
      LEFT JOIN academias a ON a.idAcademia = e.idAcademia
      LEFT JOIN Entrenadores ent ON ent.idEntrenador = e.idEntrenador
      WHERE e.idEquipo = ?;
    `;
    const results: any = await this.db.query(sql, [idEquipo]);
    if (!results || results.length === 0) {
      throw new NotFoundException(`Equipo con ID ${idEquipo} no encontrado`);
    }
    return results[0];
  }

  async createTeam(dto: CreateTeamDto) {
    const slug =
      dto.slug ||
      dto.nombre
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-');

    const sql = `
      INSERT INTO Equipos (
        nombre, slug, siglas, categoria, logo, 
        colorLocal, colorVisitante, horarioEntrenamientos, 
        diasEntrenamientos, idAcademia, idEntrenador
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      dto.nombre,
      slug,
      dto.siglas || null,
      dto.categoria,
      dto.logo || null,
      dto.colorLocal || '#0284c7',
      dto.colorVisitante || '#ffffff',
      dto.horarioEntrenamientos || null,
      dto.diasEntrenamientos || null,
      dto.idAcademia || null,
      dto.idEntrenador || null,
    ];

    const result: any = await this.db.query(sql, values);

    return {
      idEquipo: result.insertId,
      message: dto.idAcademia
        ? 'Equipo de academia registrado con éxito'
        : 'Equipo independiente registrado con éxito',
      ...dto,
      slug,
    };
  }

  async updateTeam(idEquipo: number, dto: UpdateTeamDto) {
    await this.getTeamById(idEquipo);

    const fields: string[] = [];
    const values: any[] = [];

    const allowedFields = [
      'nombre',
      'slug',
      'siglas',
      'categoria',
      'logo',
      'colorLocal',
      'colorVisitante',
      'horarioEntrenamientos',
      'diasEntrenamientos',
      'idAcademia',
      'idEntrenador',
    ];

    for (const key of allowedFields) {
      if ((dto as any)[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push((dto as any)[key]);
      }
    }

    if (fields.length === 0) {
      return { message: 'No hay cambios para actualizar' };
    }

    values.push(idEquipo);
    const sql = `UPDATE Equipos SET ${fields.join(', ')} WHERE idEquipo = ?`;
    await this.db.query(sql, values);

    return { message: 'Equipo actualizado con éxito' };
  }

  async deleteTeam(idEquipo: number) {
    await this.getTeamById(idEquipo);
    await this.db.query(`DELETE FROM Equipos WHERE idEquipo = ?`, [idEquipo]);
    return { message: 'Equipo eliminado con éxito' };
  }

  // ==========================================
  // GESTIÓN DE JUGADORES / PLANTILLA
  // ==========================================

  async getPlayersByTeam(idEquipo: number) {
    await this.getTeamById(idEquipo);
    const sql = `
      SELECT 
        idJugador,
        nombre,
        apellido,
        tipoIdentificacion,
        identificacion,
        fechaNacimiento,
        numeroCamiseta,
        foto,
        posicion,
        idEquipo
      FROM jugadores
      WHERE idEquipo = ?
      ORDER BY numeroCamiseta ASC, apellido ASC;
    `;
    return this.db.query(sql, [idEquipo]);
  }

  async addPlayerToTeam(idEquipo: number, dto: CreatePlayerDto) {
    await this.getTeamById(idEquipo);

    const sql = `
      INSERT INTO jugadores (
        nombre, apellido, tipoIdentificacion, identificacion, 
        fechaNacimiento, numeroCamiseta, foto, posicion, idEquipo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      dto.nombre,
      dto.apellido,
      dto.tipoIdentificacion || null,
      dto.identificacion || null,
      dto.fechaNacimiento || null,
      dto.numeroCamiseta,
      dto.foto || null,
      dto.posicion || null,
      idEquipo,
    ];

    const result: any = await this.db.query(sql, values);

    return {
      idJugador: result.insertId,
      idEquipo,
      message: 'Jugador añadido a la plantilla',
      ...dto,
    };
  }

  async updatePlayer(idJugador: number, dto: UpdatePlayerDto) {
    const fields: string[] = [];
    const values: any[] = [];

    const allowedFields = [
      'nombre',
      'apellido',
      'tipoIdentificacion',
      'identificacion',
      'fechaNacimiento',
      'numeroCamiseta',
      'foto',
      'posicion',
    ];

    for (const key of allowedFields) {
      if ((dto as any)[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push((dto as any)[key]);
      }
    }

    if (fields.length === 0) {
      return { message: 'No hay campos para actualizar' };
    }

    values.push(idJugador);
    const sql = `UPDATE jugadores SET ${fields.join(', ')} WHERE idJugador = ?`;
    await this.db.query(sql, values);

    return { message: 'Jugador actualizado con éxito' };
  }

  async deletePlayer(idJugador: number) {
    const res: any = await this.db.query(
      `DELETE FROM jugadores WHERE idJugador = ?`,
      [idJugador],
    );
    if (res.affectedRows === 0) {
      throw new NotFoundException(`Jugador con ID ${idJugador} no encontrado`);
    }
    return { message: 'Jugador eliminado de la plantilla' };
  }
}
