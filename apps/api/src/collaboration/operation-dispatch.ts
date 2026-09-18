import { Injectable } from '@nestjs/common';
import type { OperationType, PayloadFor } from '@umlive/contracts';
import type { Tx } from '../prisma/tx.type';
import { ElementsService, resolveElementCreateStereotype, validateElementCreatePayload } from '../uml/elements.service';
import { FeaturesService } from '../uml/features.service';
import { ParametersService } from '../uml/parameters.service';
import { assertEndsMatchKind, RelationshipsService } from '../uml/relationships.service';

/**
 * Mapa exhaustivo `OperationType → handler` (design.md D5). Un `OperationType`
 * SIN entrada acá no compila — es la mitad de la garantía que documenta D1:
 * el compilador solo audita ESTE sentido (una función de mutación nueva sin
 * `OperationType` compila verde igual, y el `rg` de la Fase 0 es la única
 * red de ese otro lado).
 *
 * Cada handler llama EXCLUSIVAMENTE la variante `…In(tx)` correspondiente —
 * nunca la función pública. Es el mecanismo que impide la transacción
 * anidada del riesgo #1 de la propuesta: la vía obvia (llamar al método
 * público, que abre su propio `$transaction`) no está disponible desde acá,
 * porque `OperationDispatcher` no recibe nada que la exponga.
 *
 * **El payload autoritativo (D5, contradicción #10).** Un handler devuelve
 * el payload que REALMENTE ocurrió, no el que llegó. Los cinco handlers de
 * creación (`element.create`, `feature.create`, `parameter.add`,
 * `literal.add`, `relationship.create`) sobrescriben `id` — y, cuando la
 * base lo asigna, `position`/`stereotype` — con lo que PostgreSQL generó.
 * `relationship.reroute` NO necesita esta corrección en esta rebanada: a
 * diferencia del diseño original (que preveía un sub-payload de extremo con
 * `id` propio, mismo molde que `RelationshipCreate.ends`), el payload de
 * `relationship.reroute` apunta a un elemento YA EXISTENTE
 * (`payload.elementId`, validado por `assertElementInDiagram`) — no hay
 * ningún id inventado por el cliente que corregir.
 */
type OperationHandlers = {
  [T in OperationType]: (tx: Tx, diagramId: string, payload: PayloadFor<T>) => Promise<PayloadFor<T>>;
};

@Injectable()
export class OperationDispatcher {
  constructor(
    private readonly elements: ElementsService,
    private readonly relationships: RelationshipsService,
    private readonly features: FeaturesService,
    private readonly parameters: ParametersService,
  ) {}

  async dispatch<T extends OperationType>(tx: Tx, diagramId: string, type: T, payload: PayloadFor<T>): Promise<PayloadFor<T>> {
    const handler = this.handlers[type] as (tx: Tx, diagramId: string, payload: PayloadFor<T>) => Promise<PayloadFor<T>>;
    return handler(tx, diagramId, payload);
  }

  private readonly handlers: OperationHandlers = {
    'element.create': async (tx, diagramId, payload) => {
      validateElementCreatePayload(payload);
      const stereotype = resolveElementCreateStereotype(payload.stereotype);
      const created = await this.elements.createElementIn(
        tx,
        diagramId,
        {
          kind: payload.kind,
          name: payload.name,
          parentId: payload.parentId,
          isAbstract: payload.isAbstract,
          stereotype: payload.stereotype,
          body: payload.body,
          x: payload.layout.x,
          y: payload.layout.y,
          width: payload.layout.width,
          height: payload.layout.height,
        },
        stereotype,
      );
      return { ...payload, id: created.id, stereotype: created.stereotype ?? undefined };
    },

    'element.rename': async (tx, diagramId, payload) => {
      await this.elements.renameElementIn(tx, diagramId, payload.id, { name: payload.name });
      return payload;
    },

    'element.setAbstract': async (tx, diagramId, payload) => {
      await this.elements.setElementAbstractIn(tx, diagramId, payload.id, { isAbstract: payload.isAbstract });
      return payload;
    },

    'element.setParent': async (tx, diagramId, payload) => {
      await this.elements.setElementParentIn(tx, diagramId, payload.id, { parentId: payload.parentId });
      return payload;
    },

    'element.setStereotype': async (tx, diagramId, payload) => {
      const updated = await this.elements.setElementStereotypeIn(tx, diagramId, payload.id, { stereotype: payload.stereotype });
      return { ...payload, stereotype: updated.stereotype };
    },

    'element.setBody': async (tx, diagramId, payload) => {
      await this.elements.setElementBodyIn(tx, diagramId, payload.id, { body: payload.body });
      return payload;
    },

    'element.move': async (tx, diagramId, payload) => {
      await this.elements.moveElementIn(tx, diagramId, payload.id, { x: payload.x, y: payload.y });
      return payload;
    },

    'element.resize': async (tx, diagramId, payload) => {
      await this.elements.resizeElementIn(tx, diagramId, payload.id, { width: payload.width, height: payload.height });
      return payload;
    },

    'element.delete': async (tx, diagramId, payload) => {
      await this.elements.deleteElementIn(tx, diagramId, payload.id);
      return payload;
    },

    'feature.create': async (tx, diagramId, payload) => {
      const created = await this.features.addFeatureIn(tx, diagramId, payload.ownerId, {
        kind: payload.kind,
        name: payload.name,
        visibility: payload.visibility,
        typeElementId: payload.typeElementId,
        typeName: payload.typeName,
        lowerBound: payload.lowerBound,
        upperBound: payload.upperBound,
        isStatic: payload.isStatic,
        isReadonly: payload.isReadonly,
        isDerived: payload.isDerived,
        isAbstract: payload.isAbstract,
        isQuery: payload.isQuery,
        defaultValue: payload.defaultValue,
      });
      return { ...payload, id: created.id, position: created.position };
    },

    'feature.update': async (tx, diagramId, payload) => {
      const { id, ...rest } = payload;
      await this.features.updateFeatureIn(tx, diagramId, id, rest);
      return payload;
    },

    'feature.delete': async (tx, diagramId, payload) => {
      await this.features.removeFeatureIn(tx, diagramId, payload.id);
      return payload;
    },

    'feature.reorder': async (tx, diagramId, payload) => {
      await this.features.reorderFeatureIn(tx, diagramId, payload.ownerId, { orderedFeatureIds: payload.orderedIds });
      return payload;
    },

    'parameter.add': async (tx, diagramId, payload) => {
      const created = await this.parameters.addParameterIn(tx, diagramId, payload.operationId, {
        name: payload.name,
        direction: payload.direction,
        typeElementId: payload.typeElementId,
        typeName: payload.typeName,
        defaultValue: payload.defaultValue,
      });
      return { ...payload, id: created.id, position: created.position };
    },

    'parameter.update': async (tx, diagramId, payload) => {
      const { id, ...rest } = payload;
      await this.parameters.updateParameterIn(tx, diagramId, id, rest);
      return payload;
    },

    'parameter.remove': async (tx, diagramId, payload) => {
      await this.parameters.removeParameterIn(tx, diagramId, payload.id);
      return payload;
    },

    'parameter.reorder': async (tx, diagramId, payload) => {
      await this.parameters.reorderParameterIn(tx, diagramId, payload.operationId, { orderedParameterIds: payload.orderedIds });
      return payload;
    },

    'literal.add': async (tx, diagramId, payload) => {
      const created = await this.parameters.addLiteralIn(tx, diagramId, payload.enumerationId, { name: payload.name });
      return { ...payload, id: created.id, position: created.position };
    },

    'literal.remove': async (tx, diagramId, payload) => {
      await this.parameters.removeLiteralIn(tx, diagramId, payload.id);
      return payload;
    },

    'literal.reorder': async (tx, diagramId, payload) => {
      await this.parameters.reorderLiteralIn(tx, diagramId, payload.enumerationId, { orderedLiteralIds: payload.orderedIds });
      return payload;
    },

    'relationship.create': async (tx, diagramId, payload) => {
      assertEndsMatchKind(payload.kind, payload.ends);
      const result = await this.relationships.createRelationshipIn(tx, diagramId, {
        kind: payload.kind,
        sourceElementId: payload.sourceElementId,
        targetElementId: payload.targetElementId,
        name: payload.name,
        ends: payload.ends,
      });
      return { ...payload, id: result.relationship.id };
    },

    'relationship.rename': async (tx, diagramId, payload) => {
      await this.relationships.renameRelationshipIn(tx, diagramId, payload.id, { name: payload.name });
      return payload;
    },

    'relationship.setStereotype': async (tx, diagramId, payload) => {
      const updated = await this.relationships.setRelationshipStereotypeIn(tx, diagramId, payload.id, { stereotype: payload.stereotype });
      return { ...payload, stereotype: updated.stereotype };
    },

    'relationship.setAssociationClass': async (tx, diagramId, payload) => {
      await this.relationships.setAssociationClassIn(tx, diagramId, payload.id, { elementId: payload.elementId });
      return payload;
    },

    'relationship.reroute': async (tx, diagramId, payload) => {
      await this.relationships.rerouteEndIn(tx, diagramId, payload.id, payload.endIndex, { elementId: payload.elementId, anchor: payload.anchor });
      return payload;
    },

    'relationship.delete': async (tx, diagramId, payload) => {
      await this.relationships.deleteRelationshipIn(tx, diagramId, payload.id);
      return payload;
    },

    'relationshipEnd.setRoleName': async (tx, diagramId, payload) => {
      await this.relationships.setEndRoleNameIn(tx, diagramId, payload.relationshipId, payload.endIndex, { roleName: payload.roleName });
      return payload;
    },

    'relationshipEnd.setMultiplicity': async (tx, diagramId, payload) => {
      await this.relationships.setEndMultiplicityIn(tx, diagramId, payload.relationshipId, payload.endIndex, {
        lowerBound: payload.lowerBound,
        upperBound: payload.upperBound,
      });
      return payload;
    },

    'relationshipEnd.setNavigability': async (tx, diagramId, payload) => {
      await this.relationships.setEndNavigabilityIn(tx, diagramId, payload.relationshipId, payload.endIndex, { isNavigable: payload.isNavigable });
      return payload;
    },

    'relationshipEnd.setAggregation': async (tx, diagramId, payload) => {
      await this.relationships.setEndAggregationIn(tx, diagramId, payload.relationshipId, payload.endIndex, { aggregation: payload.aggregation });
      return payload;
    },

    'layout.waypoints': async (tx, diagramId, payload) => {
      await this.relationships.setRelationshipWaypointsIn(tx, diagramId, payload.relationshipId, { waypoints: payload.waypoints });
      return payload;
    },

    'layout.anchors': async (tx, diagramId, payload) => {
      await this.relationships.setRelationshipAnchorsIn(tx, diagramId, payload.relationshipId, {
        sourceAnchor: payload.sourceAnchor,
        targetAnchor: payload.targetAnchor,
      });
      return payload;
    },
  };
}
