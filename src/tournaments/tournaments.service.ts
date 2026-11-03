// src/tournaments/tournaments.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CreateTournamentDto } from './dto/create-tounament.dto';


@Injectable()
export class TournamentsService {
  constructor(private readonly db: DatabaseService) {}

async createTournament(dto: CreateTournamentDto) {
  const { equiposIds, nombre, categoria, fechaInicio, fechaFin, formato_config } = dto;

  if (!equiposIds || equiposIds.length < 4) {
    throw new BadRequestException('Se requieren al menos 4 equipos para generar el torneo.');
  }

  // 1. Guardar el torneo
  const insertTorneoSql = `
    INSERT INTO torneos (nombre, categoria, formato_config, status, fechaInicio, fechaFin)
    VALUES (?, ?, ?, 'EN_CURSO', ?, ?)
  `;
  const torneoResult: any = await this.db.query(insertTorneoSql, [
    nombre,
    categoria,
    JSON.stringify(formato_config || {}),
    fechaInicio || null,
    fechaFin || null,
  ]);
  const idTorneo = torneoResult.insertId;

  // 2. Inscribir equipos al torneo
  for (const idEquipo of equiposIds) {
    await this.db.query(
      `INSERT INTO equiposTorneo (idTorneo, idEquipo) VALUES (?, ?)`,
      [idTorneo, idEquipo]
    );
  }

  // 3. Algoritmo Round-Robin para Fase de Grupos
  const matchesToInsert: Array<{
    ronda: number;
    local: number;
    visitante: number;
  }> = [];

  const teams = [...equiposIds];
  const hasGhost = teams.length % 2 !== 0;
  if (hasGhost) teams.push(-1); // "Bye" para cantidad impar de equipos

  const numTeams = teams.length;
  const totalRounds = numTeams - 1;
  const half = numTeams / 2;

  for (let round = 0; round < totalRounds; round++) {
    for (let i = 0; i < half; i++) {
      const teamA = teams[i];
      const teamB = teams[numTeams - 1 - i];

      if (teamA !== -1 && teamB !== -1) {
        // Alternar condición de local por jornada
        const local = round % 2 === 0 ? teamA : teamB;
        const visitante = round % 2 === 0 ? teamB : teamA;

        matchesToInsert.push({
          ronda: round + 1,
          local,
          visitante,
        });
      }
    }

    // Rotación del círculo manteniendo el primer equipo estático
    const firstTeam = teams[0];
    const restTeams = teams.slice(1);
    restTeams.unshift(restTeams.pop()!);
    teams.splice(0, teams.length, firstTeam, ...restTeams);
  }

    // 4. Parámetros de tiempo y duración
    const duracionTiempo = dto.duracionTiempoMinutos || 20;
    const duracionDescanso = dto.duracionDescansoMinutos || 5;
    // Ventana por partido: 2 tiempos + descanso + 15 min de calentamiento / entrega de cancha
    const duracionTotalPartidoMinutos = duracionTiempo * 2 + duracionDescanso + 15;
    const baseDate = dto.fechaInicio ? new Date(dto.fechaInicio) : new Date();

  // 5. Inserción de partidos de grupos con fechas escalonadas
  for (let idx = 0; idx < matchesToInsert.length; idx++) {
    const m = matchesToInsert[idx];
    const matchDate = new Date(baseDate.getTime() + idx * duracionTotalPartidoMinutos * 60000);

    await this.db.query(
      `INSERT INTO Partidos (
        idTorneo, fase, numeroRonda, idEquipoLocal, idEquipoVisitante, 
        duracionTiempoMinutos, duracionDescansoMinutos, fecha, status
      ) VALUES (?, 'GRUPO', ?, ?, ?, ?, ?, ?, 'SCHEDULED')`,
      [
        idTorneo,
        m.ronda,
        m.local,
        m.visitante,
        duracionTiempo,
        duracionDescanso,
        matchDate,
      ]
    );
  }

  // 6. Horarios y llaves de Play-offs (Semifinales y Final)
  const semisDate1 = new Date(baseDate.getTime() + matchesToInsert.length * duracionTotalPartidoMinutos * 60000);
  const semisDate2 = new Date(semisDate1.getTime() + duracionTotalPartidoMinutos * 60000);
  const finalDate = new Date(semisDate2.getTime() + (duracionTotalPartidoMinutos + 30) * 60000);

  // Semifinales (1º vs 4º y 2º vs 3º a definir)
  await this.db.query(
    `INSERT INTO Partidos (idTorneo, fase, numeroRonda, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
     VALUES (?, 'SEMI_FINAL', ?, ?, ?, ?, 'SCHEDULED')`,
    [idTorneo, totalRounds + 1, duracionTiempo, duracionDescanso, semisDate1]
  );

  await this.db.query(
    `INSERT INTO Partidos (idTorneo, fase, numeroRonda, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
     VALUES (?, 'SEMI_FINAL', ?, ?, ?, ?, 'SCHEDULED')`,
    [idTorneo, totalRounds + 1, duracionTiempo, duracionDescanso, semisDate2]
  );

  // Gran Final
  await this.db.query(
    `INSERT INTO Partidos (idTorneo, fase, numeroRonda, duracionTiempoMinutos, duracionDescansoMinutos, fecha, status)
     VALUES (?, 'FINAL', ?, ?, ?, ?, 'SCHEDULED')`,
    [idTorneo, totalRounds + 2, duracionTiempo, duracionDescanso, finalDate]
  );

  return {
    idTorneo,
    message: 'Torneo, inscripciones y partidos generados con éxito con sus horarios asignados.',
    partidosGruposGenerados: matchesToInsert.length,
    jornadas: totalRounds,
    fechaInicioTorneo: baseDate,
    fechaFinalEstimada: finalDate,
  };
}

    async getAllTournaments(){
        const sql = `
            SELECT 
            t.idTorneo,
            t.nombre,
            t.categoria,
            t.status,
            t.fechaInicio,
            t.fechaFin,
            t.formato_config,
            COUNT(DISTINCT et.idEquipo) AS totalEquipos,
            COUNT(DISTINCT p.idPartido) AS totalPartidos
            FROM torneos t
            LEFT JOIN equiposTorneo et ON et.idTorneo = t.idTorneo
            LEFT JOIN Partidos p ON p.idTorneo = t.idTorneo
            GROUP BY t.idTorneo
            ORDER BY t.fechaInicio DESC, t.idTorneo DESC;
        `;
        return this.db.query(sql);
    }

    async getNearestTournament(){
        const sql = `
        SELECT 
        t.idTorneo,
        t.nombre,
        t.categoria,
        t.status,
        t.fechaInicio,
        t.fechaFin,
        t.formato_config,
        COUNT(DISTINCT et.idEquipo) AS totalEquipos,
        COUNT(DISTINCT p.idPartido) AS totalPartidos
        FROM torneos t
        LEFT JOIN equiposTorneo et ON et.idTorneo = t.idTorneo
        LEFT JOIN Partidos p ON p.idTorneo = t.idTorneo
        GROUP BY t.idTorneo
        ORDER BY 
        CASE 
            WHEN t.status = 'EN_CURSO' THEN 1
            WHEN t.status = 'PROGRAMADO' AND t.fechaInicio >= CURDATE() THEN 2
            ELSE 3
        END ASC,
        t.fechaInicio ASC,
        t.idTorneo DESC
        LIMIT 1;
        `;

        const results = await this.db.query(sql);
        return results.length > 0 ? results[0] : null;
    } 
}