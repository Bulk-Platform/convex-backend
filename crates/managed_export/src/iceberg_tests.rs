use std::{
    collections::{
        BTreeMap,
        HashMap,
    },
    sync::Arc,
};

use arrow_iceberg::{
    Array,
    BooleanArray,
    Float64Array,
    Int64Array,
    LargeBinaryArray,
    StringArray,
};
use futures::TryStreamExt;
use iceberg::{
    memory::{
        MemoryCatalogBuilder,
        MEMORY_CATALOG_WAREHOUSE,
    },
    spec::{
        PrimitiveType,
        Type,
    },
    CatalogBuilder,
};
use iceberg_storage_opendal::OpenDalStorageFactory;
use serde_json::{
    json,
    Value as JsonValue,
};
use value::{
    ConvexValue,
    FieldName,
};

use super::*;

pub(crate) async fn memory_catalog() -> Result<Arc<dyn Catalog>> {
    Ok(Arc::new(
        MemoryCatalogBuilder::default()
            .with_storage_factory(Arc::new(OpenDalStorageFactory::Memory))
            .load(
                "memory",
                HashMap::from([(
                    MEMORY_CATALOG_WAREHOUSE.to_owned(),
                    "memory://warehouse".to_owned(),
                )]),
            )
            .await?,
    ))
}

/// `payload` is any JSON value; the document holds it in field `v`.
pub(crate) fn change(id: &str, ts: u64, payload: Option<&str>) -> Change {
    let document = payload.map(|payload| {
        let payload: JsonValue = serde_json::from_str(payload).expect("payload is JSON");
        document(json!({ "v": payload })).expect("payload is a Convex value")
    });
    Change {
        id: id.to_owned(),
        ts,
        document,
    }
}

fn document(json: JsonValue) -> Result<ConvexObject> {
    ConvexObject::try_from(ConvexValue::try_from(json)?)
}

pub(crate) async fn read(table: &Table) -> Result<Vec<Change>> {
    let batches: Vec<_> = table
        .scan()
        .build()?
        .to_arrow()
        .await?
        .try_collect()
        .await?;
    let schema = table.metadata().current_schema();
    let mut changes = vec![];
    for batch in batches {
        let column = |name: &str| batch.column_by_name(name).unwrap().as_any();
        let ids = column(columns::ID_COLUMN)
            .downcast_ref::<StringArray>()
            .unwrap();
        let ts = column(columns::TS_COLUMN)
            .downcast_ref::<Int64Array>()
            .unwrap();
        let deleted = column(columns::DELETED_COLUMN)
            .downcast_ref::<BooleanArray>()
            .unwrap();
        let rescued = column(columns::RESCUED_COLUMN)
            .downcast_ref::<StringArray>()
            .unwrap();
        for row in 0..batch.num_rows() {
            let document = if deleted.value(row) {
                None
            } else {
                // Rebuild the document from its typed columns and `_rescued`,
                // so a round trip compares whole documents.
                let mut fields: BTreeMap<FieldName, ConvexValue> = BTreeMap::new();
                if !rescued.is_null(row) {
                    let ConvexValue::Object(misfits) = ConvexValue::from_clean_lossless(
                        serde_json::from_str(rescued.value(row))?,
                    )?
                    else {
                        anyhow::bail!("_rescued is not an object");
                    };
                    fields.extend(misfits);
                }
                let metadata = [
                    columns::ID_COLUMN,
                    columns::TS_COLUMN,
                    columns::DELETED_COLUMN,
                    columns::CREATION_TIME_COLUMN,
                    columns::RESCUED_COLUMN,
                ];
                for field in schema.as_struct().fields() {
                    let name = field.name.as_str();
                    let array = batch.column_by_name(name).unwrap();
                    if metadata.contains(&name) || array.is_null(row) {
                        continue;
                    }
                    let value = match &*field.field_type {
                        Type::Primitive(PrimitiveType::String)
                            if field.doc.as_deref() == Some(columns::JSON_DOC) =>
                        {
                            let text = array.as_any().downcast_ref::<StringArray>().unwrap();
                            ConvexValue::from_clean_lossless(serde_json::from_str(
                                text.value(row),
                            )?)?
                        },
                        Type::Primitive(PrimitiveType::String) => {
                            let text = array.as_any().downcast_ref::<StringArray>().unwrap();
                            ConvexValue::try_from(text.value(row).to_owned())?
                        },
                        Type::Primitive(PrimitiveType::Double) => {
                            let doubles = array.as_any().downcast_ref::<Float64Array>().unwrap();
                            ConvexValue::Float64(doubles.value(row))
                        },
                        Type::Primitive(PrimitiveType::Long) => {
                            let longs = array.as_any().downcast_ref::<Int64Array>().unwrap();
                            ConvexValue::Int64(longs.value(row))
                        },
                        Type::Primitive(PrimitiveType::Boolean) => {
                            let bools = array.as_any().downcast_ref::<BooleanArray>().unwrap();
                            ConvexValue::Boolean(bools.value(row))
                        },
                        Type::Primitive(PrimitiveType::Binary) => {
                            let bytes = array.as_any().downcast_ref::<LargeBinaryArray>().unwrap();
                            ConvexValue::try_from(bytes.value(row).to_vec())?
                        },
                        other => anyhow::bail!("read() does not handle {other}"),
                    };
                    fields.insert(name.parse()?, value);
                }
                Some(ConvexObject::try_from(fields)?)
            };
            changes.push(Change {
                id: ids.value(row).to_owned(),
                ts: ts.value(row).try_into()?,
                document,
            });
        }
    }
    changes.sort_by_key(|c| (c.id.clone(), c.ts));
    Ok(changes)
}
