import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class CatalogsService {
  constructor(private readonly db: DatabaseService) {}

  getAcademies() {
    return this.db.query(
      `SELECT idAcademia, nombre, nombreCorto, logo
       FROM academias
       ORDER BY nombre ASC`,
    );
  }

  getCoaches() {
    return this.db.query(
      `SELECT
         en.idEntrenador,
         en.nombre,
         en.apellido,
         en.especialidad,
         en.idAcademia,
         a.nombre AS nombreAcademia
       FROM entrenadores en
       LEFT JOIN academias a ON a.idAcademia = en.idAcademia
       ORDER BY en.apellido ASC, en.nombre ASC`,
    );
  }
}
