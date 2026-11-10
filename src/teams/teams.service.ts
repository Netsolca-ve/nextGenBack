import { Injectable, NotFoundException } from '@nestjs/common';
import { createSlug } from '../common/slug';
import { DatabaseService } from '../database/database.service';
import { imageKeys } from '../storage/image-presets';
import { ImageChange, StorageService } from '../storage/storage.service';
import {
  CreateTeamDto,
  UpdateTeamDto,
  CreatePlayerDto,
  UpdatePlayerDto,
} from './dto/teams.dto';

@Injectable()
export class TeamsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

async getAllTeams() {
    // El conteo va en una subconsulta para no necesitar GROUP BY: TiDB/MySQL
    // con ONLY_FULL_GROUP_BY rechaza columnas de tablas unidas que no estén
    // en el GROUP BY.
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
        (SELECT COUNT(*) FROM jugadores j WHERE j.idEquipo = e.idEquipo) AS totalJugadores
      FROM equipos e
      LEFT JOIN academias a ON a.idAcademia = e.idAcademia
      LEFT JOIN entrenadores ent ON ent.idEntrenador = e.idEntrenador
      ORDER BY e.nombre ASC;
    `;
    const teams = await this.db.query(sql);
    return teams.map((team) => this.storage.withUrls(team, 'logo'));
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
      FROM equipos e
      LEFT JOIN academias a ON a.idAcademia = e.idAcademia
      LEFT JOIN entrenadores ent ON ent.idEntrenador = e.idEntrenador
      WHERE e.idEquipo = ?;
    `;
    const results: any = await this.db.query(sql, [idEquipo]);
    if (!results || results.length === 0) {
      throw new NotFoundException(`Equipo con ID ${idEquipo} no encontrado`);
    }
    return this.storage.withUrls(results[0], 'logo');
  }

  /** Fila tal cual está en la BD (logo como key, sin URL pública). */
  private async getTeamRow(idEquipo: number) {
    const results: any[] = await this.db.query(
      `SELECT idEquipo, nombre, slug, logo FROM equipos WHERE idEquipo = ?`,
      [idEquipo],
    );
    if (!results.length) {
      throw new NotFoundException(`Equipo con ID ${idEquipo} no encontrado`);
    }
    return results[0];
  }

  async createTeam(dto: CreateTeamDto, logo?: Express.Multer.File) {
    const slug = await this.createUniqueSlug(dto.nombre);
    const incomingLogo = logo
      ? await this.storage.uploadTemp(logo.buffer, 'team')
      : dto.logo;
    const logoChange = await this.storage.assignImage({
      incoming: incomingLogo,
      currentKey: null,
      targetKey: imageKeys.team(slug),
    });

    const sql = `
      INSERT INTO equipos (
        nombre, slug, siglas, categoria, logo, 
        colorLocal, colorVisitante, horarioEntrenamientos, 
        diasEntrenamientos, idAcademia, idEntrenador
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      dto.nombre,
      slug,
      dto.siglas || '',
      dto.categoria,
      logoChange.key,
      dto.colorLocal || '#0284c7',
      dto.colorVisitante || '#ffffff',
      dto.horarioEntrenamientos || null,
      dto.diasEntrenamientos || null,
      dto.idAcademia || null,
      dto.idEntrenador || null,
    ];

    let result: any;
    try {
      result = await this.db.query(sql, values);
    } catch (error) {
      await this.storage.rollback(logoChange);
      throw error;
    }
    await this.storage.commit(logoChange);

    return {
      idEquipo: result.insertId,
      message: dto.idAcademia
        ? 'Equipo de academia registrado con éxito'
        : 'Equipo independiente registrado con éxito',
      ...dto,
      logo: this.storage.url(logoChange.key),
      slug,
    };
  }

  /**
   * Slug a partir del nombre, único entre los equipos (se le añade -2, -3...
   * si ya existe). También nombra el logo en R2, por eso no puede repetirse.
   */
  private async createUniqueSlug(nombre: string, excludeIdEquipo?: number): Promise<string> {
    const base = createSlug(nombre, 'equipo');
    const rows: any[] = await this.db.query(
      `SELECT slug FROM equipos WHERE (slug = ? OR slug LIKE ?) AND idEquipo <> ?`,
      [base, `${base}-%`, excludeIdEquipo ?? 0],
    );
    const taken = new Set(rows.map((row) => row.slug));

    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix++) {
      slug = `${base}-${suffix}`;
    }
    return slug;
  }

  async updateTeam(idEquipo: number, dto: UpdateTeamDto) {
    const current = await this.getTeamRow(idEquipo);

    // El slug sigue al nombre; sin slug guardado (equipos antiguos) se genera.
    const slug =
      dto.nombre !== undefined || !current.slug
        ? await this.createUniqueSlug(dto.nombre ?? current.nombre, idEquipo)
        : current.slug;

    const fields: string[] = [];
    const values: any[] = [];

    const allowedFields = [
      'nombre',
      'siglas',
      'categoria',
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

    const logoChange = await this.storage.assignImage({
      incoming: dto.logo,
      currentKey: current.logo,
      targetKey: imageKeys.team(slug),
    });

    if (slug !== current.slug) {
      fields.push('slug = ?');
      values.push(slug);
    }
    if (logoChange.key !== current.logo) {
      fields.push('logo = ?');
      values.push(logoChange.key);
    }

    if (fields.length === 0) {
      // Un logo nuevo puede pisar la misma key: no cambia la BD, pero sí R2
      await this.storage.commit(logoChange);
      return {
        message: logoChange.obsolete.length
          ? 'Equipo actualizado con éxito'
          : 'No hay cambios para actualizar',
        slug,
        logo: this.storage.url(logoChange.key),
      };
    }

    values.push(idEquipo);
    const sql = `UPDATE equipos SET ${fields.join(', ')} WHERE idEquipo = ?`;
    try {
      await this.db.query(sql, values);
    } catch (error) {
      await this.storage.rollback(logoChange);
      throw error;
    }
    await this.storage.commit(logoChange);

    // Las fotos de los jugadores van en una carpeta con el slug del equipo
    if (slug !== current.slug) {
      await this.renamePlayerPhotos(idEquipo, slug);
    }

    return {
      message: 'Equipo actualizado con éxito',
      slug,
      logo: this.storage.url(logoChange.key),
    };
  }

  /** Mueve las fotos de la plantilla a la carpeta del nuevo slug del equipo. */
  private async renamePlayerPhotos(idEquipo: number, teamSlug: string) {
    const players: any[] = await this.db.query(
      `SELECT idJugador, nombre, apellido, foto FROM jugadores WHERE idEquipo = ?`,
      [idEquipo],
    );

    for (const player of players) {
      if (!this.storage.isManagedKey(player.foto)) continue;

      const change = await this.storage.assignImage({
        incoming: undefined,
        currentKey: player.foto,
        targetKey: this.playerPhotoKey(teamSlug, player),
      });
      if (change.key === player.foto) continue;

      await this.db.query(`UPDATE jugadores SET foto = ? WHERE idJugador = ?`, [
        change.key,
        player.idJugador,
      ]);
      await this.storage.commit(change);
    }
  }

  private playerPhotoKey(
    teamSlug: string,
    player: { idJugador: number; nombre: string; apellido: string },
  ) {
    return imageKeys.player(
      teamSlug,
      createSlug(`${player.nombre} ${player.apellido}`, 'jugador'),
      player.idJugador,
    );
  }

  async deleteTeam(idEquipo: number) {
    const team = await this.getTeamRow(idEquipo);
    const players: any[] = await this.db.query(
      `SELECT foto FROM jugadores WHERE idEquipo = ?`,
      [idEquipo],
    );
    await this.db.query(`DELETE FROM equipos WHERE idEquipo = ?`, [idEquipo]);
    await this.storage.delete(team.logo, ...players.map((player) => player.foto));
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
    const players = await this.db.query(sql, [idEquipo]);
    return players.map((player) => this.storage.withUrls(player, 'foto'));
  }

  async addPlayerToTeam(idEquipo: number, dto: CreatePlayerDto) {
    const team = await this.getTeamRow(idEquipo);
    const incomingFoto = this.storage.toKey(dto.foto);

    // La foto se nombra con el idJugador: se inserta sin la foto subida y se
    // asigna después.
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
      this.storage.isTempKey(incomingFoto) ? null : incomingFoto,
      dto.posicion || null,
      idEquipo,
    ];

    const result: any = await this.db.query(sql, values);
    const idJugador = result.insertId;
    let foto = values[6] as string | null;

    if (this.storage.isTempKey(incomingFoto)) {
      const change = await this.storage.assignImage({
        incoming: incomingFoto,
        currentKey: null,
        targetKey: this.playerPhotoKey(team.slug || createSlug(team.nombre, 'equipo'), {
          idJugador,
          nombre: dto.nombre,
          apellido: dto.apellido,
        }),
      });
      await this.db.query(`UPDATE jugadores SET foto = ? WHERE idJugador = ?`, [
        change.key,
        idJugador,
      ]);
      await this.storage.commit(change);
      foto = change.key;
    }

    return {
      idJugador,
      idEquipo,
      message: 'Jugador añadido a la plantilla',
      ...dto,
      foto: this.storage.url(foto),
    };
  }

  async updatePlayer(idJugador: number, dto: UpdatePlayerDto) {
    const rows: any[] = await this.db.query(
      `SELECT j.idJugador, j.nombre, j.apellido, j.foto, e.slug, e.nombre AS nombreEquipo
       FROM jugadores j
       LEFT JOIN equipos e ON e.idEquipo = j.idEquipo
       WHERE j.idJugador = ?`,
      [idJugador],
    );
    if (!rows.length) {
      throw new NotFoundException(`Jugador con ID ${idJugador} no encontrado`);
    }
    const current = rows[0];

    const fields: string[] = [];
    const values: any[] = [];

    const allowedFields = [
      'nombre',
      'apellido',
      'tipoIdentificacion',
      'identificacion',
      'fechaNacimiento',
      'numeroCamiseta',
      'posicion',
    ];

    for (const key of allowedFields) {
      if ((dto as any)[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push((dto as any)[key]);
      }
    }

    // Cambiar el nombre o la foto renombra / reemplaza el archivo en R2
    const fotoChange = await this.storage.assignImage({
      incoming: dto.foto,
      currentKey: current.foto,
      targetKey: this.playerPhotoKey(current.slug || createSlug(current.nombreEquipo, 'equipo'), {
        idJugador,
        nombre: dto.nombre ?? current.nombre,
        apellido: dto.apellido ?? current.apellido,
      }),
    });
    if (fotoChange.key !== current.foto) {
      fields.push('foto = ?');
      values.push(fotoChange.key);
    }

    if (fields.length === 0) {
      // Una foto nueva puede pisar la misma key: no cambia la BD, pero sí R2
      await this.storage.commit(fotoChange);
      return {
        message: fotoChange.obsolete.length
          ? 'Jugador actualizado con éxito'
          : 'No hay campos para actualizar',
        foto: this.storage.url(fotoChange.key),
      };
    }

    values.push(idJugador);
    const sql = `UPDATE jugadores SET ${fields.join(', ')} WHERE idJugador = ?`;
    try {
      await this.db.query(sql, values);
    } catch (error) {
      await this.storage.rollback(fotoChange);
      throw error;
    }
    await this.storage.commit(fotoChange);

    return { message: 'Jugador actualizado con éxito', foto: this.storage.url(fotoChange.key) };
  }

  async deletePlayer(idJugador: number) {
    const players: any[] = await this.db.query(
      `SELECT foto FROM jugadores WHERE idJugador = ?`,
      [idJugador],
    );
    const res: any = await this.db.query(
      `DELETE FROM jugadores WHERE idJugador = ?`,
      [idJugador],
    );
    if (res.affectedRows === 0) {
      throw new NotFoundException(`Jugador con ID ${idJugador} no encontrado`);
    }
    await this.storage.delete(players[0]?.foto);
    return { message: 'Jugador eliminado de la plantilla' };
  }
}
