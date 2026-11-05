import { Controller, Get } from '@nestjs/common';
import { CatalogsService } from './catalogs.service';

@Controller()
export class CatalogsController {
  constructor(private readonly catalogsService: CatalogsService) {}

  @Get('academies')
  getAcademies() {
    return this.catalogsService.getAcademies();
  }

  @Get('coaches')
  getCoaches() {
    return this.catalogsService.getCoaches();
  }
}
